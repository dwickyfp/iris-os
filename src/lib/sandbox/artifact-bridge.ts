import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { ArtifactService } from "lib/ai/artifacts";
import { detectSandboxArtifactMime } from "./artifact-mime";
import { safeSandboxRelativePath } from "./artifact-path";
import {
  DEFAULT_SANDBOX_ARTIFACT_LIMITS,
  type SandboxArtifactContext,
  type SandboxArtifactInput,
  type SandboxArtifactLimits,
  type SandboxArtifactResult,
} from "./artifact-types";
import type { SandboxArtifactHook, SandboxOutputFile } from "./contracts";

export class SandboxArtifactBridge {
  constructor(
    private readonly artifacts: ArtifactService,
    private readonly inputRoot: string,
    private readonly outputRoot: string,
    private readonly limits: SandboxArtifactLimits = DEFAULT_SANDBOX_ARTIFACT_LIMITS,
  ) {}

  async stageInputs(
    inputs: readonly SandboxArtifactInput[],
    context: SandboxArtifactContext,
  ): Promise<void> {
    if (inputs.length > this.limits.maxInputCount) {
      throw new Error("SANDBOX_ARTIFACT_INPUT_COUNT_EXCEEDED");
    }
    await mkdir(this.inputRoot, { recursive: true });
    const root = await realpath(this.inputRoot);
    let total = 0;
    const staged: string[] = [];
    try {
      for (const input of inputs) {
        const relative = safeSandboxRelativePath(input.destination);
        const { bytes } = await this.artifacts.resolveForSandboxInput({
          artifactId: input.artifactId,
          userId: context.userId,
          sourceRunId: context.sourceRunId,
        });
        total += bytes.byteLength;
        if (bytes.byteLength > this.limits.maxInputFileBytes) {
          throw new Error("SANDBOX_ARTIFACT_INPUT_FILE_SIZE_EXCEEDED");
        }
        if (total > this.limits.maxInputTotalBytes) {
          throw new Error("SANDBOX_ARTIFACT_INPUT_TOTAL_SIZE_EXCEEDED");
        }
        const destination = path.join(root, relative);
        await ensureSandboxDirectory(root, path.posix.dirname(relative));
        const parent = await realpath(path.dirname(destination));
        if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) {
          throw new Error("SANDBOX_ARTIFACT_PATH_ESCAPE");
        }
        const handle = await open(
          destination,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        staged.push(destination);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      await Promise.all(staged.map((file) => rm(file, { force: true })));
      throw error;
    }
  }

  async collectOutputs(
    candidates: readonly string[],
    context: SandboxArtifactContext,
  ): Promise<SandboxArtifactResult[]> {
    if (candidates.length > this.limits.maxOutputCount) {
      throw new Error("SANDBOX_ARTIFACT_OUTPUT_COUNT_EXCEEDED");
    }
    const duplicateCheck = new Set<string>();
    const outputRoot = await realpath(this.outputRoot);
    const inspected: Array<{
      bytes: Buffer;
      mediaType: string;
      relativePath: string;
      sha256: string;
    }> = [];
    let total = 0;

    for (const candidate of candidates) {
      const relativePath = safeSandboxRelativePath(candidate);
      if (duplicateCheck.has(relativePath)) {
        throw new Error("SANDBOX_ARTIFACT_OUTPUT_PATH_DUPLICATE");
      }
      duplicateCheck.add(relativePath);
      const absolute = path.join(outputRoot, relativePath);
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error("SANDBOX_ARTIFACT_OUTPUT_NOT_REGULAR_FILE");
      }
      const resolved = await realpath(absolute);
      if (!resolved.startsWith(`${outputRoot}${path.sep}`)) {
        throw new Error("SANDBOX_ARTIFACT_PATH_ESCAPE");
      }
      if (stat.size > this.limits.maxOutputFileBytes) {
        throw new Error("SANDBOX_ARTIFACT_OUTPUT_FILE_SIZE_EXCEEDED");
      }
      total += stat.size;
      if (total > this.limits.maxOutputTotalBytes) {
        throw new Error("SANDBOX_ARTIFACT_OUTPUT_TOTAL_SIZE_EXCEEDED");
      }
      const handle = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let bytes: Buffer;
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          opened.size !== stat.size
        ) {
          throw new Error("SANDBOX_ARTIFACT_OUTPUT_CHANGED");
        }
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      inspected.push({
        bytes,
        mediaType: detectSandboxArtifactMime(bytes, relativePath),
        relativePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }

    const results: SandboxArtifactResult[] = [];
    const created: SandboxArtifactResult[] = [];
    try {
      for (const output of inspected) {
        const provenance = {
          executionId: context.executionId,
          relativePath: output.relativePath,
          sha256: output.sha256,
        };
        const existing = await this.artifacts.findOutput(provenance);
        if (existing) {
          await this.artifacts.resolveForSandboxInput({
            artifactId: existing.artifactId,
            userId: context.userId,
            sourceRunId: context.targetRunId,
          });
          results.push({ ...existing, relativePath: output.relativePath });
          continue;
        }
        let newlyCreated = true;
        const artifact = await this.artifacts
          .create({
            content: output.bytes,
            filename: path.posix.basename(output.relativePath),
            mediaType: output.mediaType,
            userId: context.userId,
            runId: context.targetRunId,
            outputProvenance: provenance,
          })
          .catch(async (error) => {
            const raced = await this.artifacts.findOutput(provenance);
            if (!raced) throw error;
            newlyCreated = false;
            return raced;
          });
        const result = { ...artifact, relativePath: output.relativePath };
        if (newlyCreated) created.push(result);
        await this.artifacts.resolveForSandboxInput({
          artifactId: artifact.artifactId,
          userId: context.userId,
          sourceRunId: context.targetRunId,
        });
        results.push(result);
      }
      return results;
    } catch (error) {
      await Promise.allSettled(
        created.map((artifact) => this.artifacts.discard(artifact)),
      );
      throw error;
    }
  }
}

export function createSandboxArtifactHook(
  artifacts: ArtifactService,
  limits: SandboxArtifactLimits = DEFAULT_SANDBOX_ARTIFACT_LIMITS,
): SandboxArtifactHook {
  return {
    async capture({ scope, executionId, files }) {
      const inspected = inspectOutputFiles(files, limits);
      const created: SandboxArtifactResult[] = [];
      try {
        for (const output of inspected) {
          const artifact = await artifacts.create({
            filename: path.posix.basename(output.relativePath),
            mediaType: output.mediaType,
            content: output.content,
            userId: scope.userId,
            runId: scope.runId,
            outputProvenance: {
              executionId,
              relativePath: output.relativePath,
              sha256: createHash("sha256").update(output.content).digest("hex"),
            },
          });
          created.push({ ...artifact, relativePath: output.relativePath });
        }
        return created;
      } catch (error) {
        await Promise.allSettled(
          created.map((artifact) => artifacts.discard(artifact)),
        );
        throw error;
      }
    },
    async discard(captured) {
      await Promise.all(
        (captured as SandboxArtifactResult[]).map((artifact) =>
          artifacts.discard(artifact),
        ),
      );
    },
    reapCleanup(input) {
      return artifacts.reapCleanup(input);
    },
  };
}

function inspectOutputFiles(
  files: readonly SandboxOutputFile[],
  limits: SandboxArtifactLimits,
) {
  if (files.length > limits.maxOutputCount)
    throw new Error("SANDBOX_ARTIFACT_OUTPUT_COUNT_EXCEEDED");
  let totalBytes = 0;
  return files.map((file) => {
    const relativePath = safeSandboxRelativePath(file.path);
    const content = Buffer.from(
      file.content,
      file.encoding === "base64" ? "base64" : "utf8",
    );
    totalBytes += content.byteLength;
    if (content.byteLength > limits.maxOutputFileBytes)
      throw new Error("SANDBOX_ARTIFACT_OUTPUT_FILE_SIZE_EXCEEDED");
    if (totalBytes > limits.maxOutputTotalBytes)
      throw new Error("SANDBOX_ARTIFACT_OUTPUT_TOTAL_SIZE_EXCEEDED");
    return {
      content,
      mediaType: detectSandboxArtifactMime(content, relativePath),
      relativePath,
    };
  });
}

async function ensureSandboxDirectory(
  root: string,
  relativeDirectory: string,
): Promise<void> {
  if (relativeDirectory === ".") return;
  let current = root;
  for (const segment of relativeDirectory.split("/")) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("SANDBOX_ARTIFACT_PATH_ESCAPE");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

export async function listSandboxOutputCandidates(
  outputRoot: string,
): Promise<string[]> {
  const candidates: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory())
        await visit(path.join(directory, entry.name), relative);
      else candidates.push(relative);
    }
  }
  await visit(outputRoot, "");
  return candidates;
}
