import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactRecord, ArtifactService } from "lib/ai/artifacts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  SandboxArtifactBridge,
  createSandboxArtifactHook,
} from "./artifact-bridge";
import { detectSandboxArtifactMime } from "./artifact-mime";

let directory: string;
let inputRoot: string;
let outputRoot: string;
const context = {
  executionId: randomUUID(),
  userId: randomUUID(),
  sourceRunId: randomUUID(),
  targetRunId: randomUUID(),
};
const limits = {
  maxInputCount: 2,
  maxInputFileBytes: 12,
  maxInputTotalBytes: 16,
  maxOutputCount: 3,
  maxOutputFileBytes: 20,
  maxOutputTotalBytes: 24,
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "iris-artifacts-"));
  inputRoot = path.join(directory, "inputs");
  outputRoot = path.join(directory, "outputs");
  await mkdir(outputRoot);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function bridge(service: Record<string, unknown>) {
  return new SandboxArtifactBridge(
    service as unknown as ArtifactService,
    inputRoot,
    outputRoot,
    limits,
  );
}

function record(relativePath: string, content: Buffer): ArtifactRecord {
  return {
    artifactId: randomUUID(),
    storageKey: randomUUID(),
    filename: path.basename(relativePath),
    mediaType: "application/json",
    size: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    userId: context.userId,
    runId: context.targetRunId,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("sandbox artifact input staging", () => {
  test.each([
    "/absolute.txt",
    "../escape.txt",
    "a/../b.txt",
    "a\\b.txt",
    "nul\0.txt",
  ])("rejects hostile destination %s", async (destination) => {
    const resolveForSandboxInput = vi.fn();
    await expect(
      bridge({ resolveForSandboxInput }).stageInputs(
        [{ artifactId: randomUUID(), destination }],
        context,
      ),
    ).rejects.toThrow("SANDBOX_ARTIFACT_PATH_INVALID");
    expect(resolveForSandboxInput).not.toHaveBeenCalled();
  });

  test("stages only verified artifactId bytes and enforces aggregate size", async () => {
    const resolveForSandboxInput = vi
      .fn()
      .mockResolvedValueOnce({ bytes: Buffer.from("12345678") })
      .mockResolvedValueOnce({ bytes: Buffer.from("abcdefghij") });
    const sandbox = bridge({ resolveForSandboxInput });
    await expect(
      sandbox.stageInputs(
        [
          { artifactId: randomUUID(), destination: "nested/a.txt" },
          { artifactId: randomUUID(), destination: "b.txt" },
        ],
        context,
      ),
    ).rejects.toThrow("SANDBOX_ARTIFACT_INPUT_TOTAL_SIZE_EXCEEDED");
    await expect(
      readFile(path.join(inputRoot, "nested/a.txt")),
    ).rejects.toThrow();
    expect(resolveForSandboxInput).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: context.userId,
        sourceRunId: context.sourceRunId,
      }),
    );
  });

  test("rejects a symlinked destination ancestor", async () => {
    await mkdir(inputRoot);
    await symlink(directory, path.join(inputRoot, "linked"));
    await expect(
      bridge({
        resolveForSandboxInput: vi.fn(async () => ({
          artifact: record("file.txt", Buffer.from("ok")),
          bytes: Buffer.from("ok"),
        })),
      }).stageInputs(
        [{ artifactId: randomUUID(), destination: "linked/file.txt" }],
        context,
      ),
    ).rejects.toThrow("SANDBOX_ARTIFACT_PATH_ESCAPE");
  });
});

describe("sandbox artifact output collection", () => {
  test("rejects symlinks, hardlinks, and oversized regular files", async () => {
    const outside = path.join(directory, "outside.json");
    await writeFile(outside, "{}");
    await symlink(outside, path.join(outputRoot, "link.json"));
    await expect(
      bridge({}).collectOutputs(["link.json"], context),
    ).rejects.toThrow("SANDBOX_ARTIFACT_OUTPUT_NOT_REGULAR_FILE");

    await link(outside, path.join(outputRoot, "hard.json"));
    await expect(
      bridge({}).collectOutputs(["hard.json"], context),
    ).rejects.toThrow("SANDBOX_ARTIFACT_OUTPUT_NOT_REGULAR_FILE");

    await writeFile(path.join(outputRoot, "large.txt"), "x".repeat(21));
    await expect(
      bridge({}).collectOutputs(["large.txt"], context),
    ).rejects.toThrow("SANDBOX_ARTIFACT_OUTPUT_FILE_SIZE_EXCEEDED");
  });

  test("detects supported MIME signatures and rejects extension mismatch", () => {
    expect(
      detectSandboxArtifactMime(
        Buffer.concat([
          Buffer.from("89504e470d0a1a0a", "hex"),
          Buffer.from("png"),
        ]),
        "image.png",
      ),
    ).toBe("image/png");
    expect(
      detectSandboxArtifactMime(Buffer.from('{"ok":true}'), "data.json"),
    ).toBe("application/json");
    expect(() =>
      detectSandboxArtifactMime(Buffer.from("%PDF-1.7"), "report.txt"),
    ).toThrow("SANDBOX_ARTIFACT_MIME_EXTENSION_MISMATCH");
  });

  test("canonicalizes for the target owner/run and dedupes retries", async () => {
    const content = Buffer.from('{"ok":true}');
    await writeFile(path.join(outputRoot, "result.json"), content);
    const existing = record("result.json", content);
    const findOutput = vi.fn().mockResolvedValue(existing);
    const create = vi.fn();
    const resolveForSandboxInput = vi.fn(async () => ({
      artifact: existing,
      bytes: content,
    }));
    const results = await bridge({
      findOutput,
      create,
      resolveForSandboxInput,
    }).collectOutputs(["result.json"], context);
    expect(results).toEqual([{ ...existing, relativePath: "result.json" }]);
    expect(findOutput).toHaveBeenCalledWith({
      executionId: context.executionId,
      relativePath: "result.json",
      sha256: existing.sha256,
    });
    expect(create).not.toHaveBeenCalled();
    expect(resolveForSandboxInput).toHaveBeenCalledWith({
      artifactId: existing.artifactId,
      userId: context.userId,
      sourceRunId: context.targetRunId,
    });
  });

  test("cleans newly canonicalized artifacts when a later output fails", async () => {
    await writeFile(path.join(outputRoot, "one.json"), "{}");
    await writeFile(path.join(outputRoot, "two.json"), "[]");
    const first = record("one.json", Buffer.from("{}"));
    const create = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error("repository failed"));
    const discard = vi.fn(async () => undefined);
    const resolveForSandboxInput = vi.fn(async () => ({
      artifact: first,
      bytes: Buffer.from("{}"),
    }));
    await expect(
      bridge({
        findOutput: vi.fn(async () => null),
        create,
        discard,
        resolveForSandboxInput,
      }).collectOutputs(["one.json", "two.json"], context),
    ).rejects.toThrow("repository failed");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: context.userId,
        runId: context.targetRunId,
      }),
    );
    expect(discard).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: first.artifactId }),
    );
  });
});

describe("production sandbox artifact hook", () => {
  test("captures sequentially and discards created artifacts on partial failure", async () => {
    const first = record("one.json", Buffer.from("{}"));
    const active = new Set<string>();
    const create = vi
      .fn()
      .mockImplementationOnce(async () => {
        active.add(first.artifactId);
        return first;
      })
      .mockRejectedValueOnce(new Error("second artifact failed"));
    const discard = vi.fn(async ({ artifactId }: { artifactId: string }) => {
      active.delete(artifactId);
    });
    const hook = createSandboxArtifactHook(
      { create, discard } as unknown as ArtifactService,
      limits,
    );

    await expect(
      hook.capture({
        scope: { runId: context.targetRunId, userId: context.userId },
        sessionId: randomUUID(),
        executionId: context.executionId,
        files: [
          { path: "one.json", content: "{}", encoding: "utf8" },
          { path: "two.json", content: "[]", encoding: "utf8" },
        ],
      }),
    ).rejects.toThrow("second artifact failed");

    expect(create).toHaveBeenCalledTimes(2);
    expect(discard).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: first.artifactId }),
    );
    expect(active).toEqual(new Set());
  });

  test("discards a completed captured batch when finalization fails", async () => {
    const first = record("one.json", Buffer.from("{}"));
    const second = record("two.json", Buffer.from("[]"));
    const discard = vi.fn(async () => undefined);
    const hook = createSandboxArtifactHook(
      {
        create: vi
          .fn()
          .mockResolvedValueOnce(first)
          .mockResolvedValueOnce(second),
        discard,
      } as unknown as ArtifactService,
      limits,
    );
    const captured = await hook.capture({
      scope: { runId: context.targetRunId, userId: context.userId },
      sessionId: randomUUID(),
      executionId: context.executionId,
      files: [
        { path: "one.json", content: "{}", encoding: "utf8" },
        { path: "two.json", content: "[]", encoding: "utf8" },
      ],
    });

    await hook.discard?.(captured);

    expect(discard).toHaveBeenCalledTimes(2);
    expect(discard).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: first.artifactId }),
    );
    expect(discard).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: second.artifactId }),
    );
  });
});
