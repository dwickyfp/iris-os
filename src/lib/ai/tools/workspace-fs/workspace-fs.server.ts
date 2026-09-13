import "server-only";

import { tool as createTool } from "ai";
import type { AgentRuntimeContext } from "lib/ai/agent/runtime-context";
import { ArtifactService } from "lib/ai/artifacts";
import { WORKSPACE_FS_LIMITS } from "lib/ai/workspace-fs/limits";
import { WorkspaceFileService } from "lib/ai/workspace-fs/service";
import { artifactRepository, workspaceFileRepository } from "lib/db/repository";
import { serverFileStorage } from "lib/file-storage";
import type { FileStorage } from "lib/file-storage/file-storage.interface";
import { z } from "zod";

const service = new WorkspaceFileService(workspaceFileRepository);
const artifactService = new ArtifactService(
  serverFileStorage,
  artifactRepository,
);

const pathSchema = z
  .string()
  .min(1)
  .max(WORKSPACE_FS_LIMITS.maxPathLength)
  .describe(
    "Workspace-relative POSIX path, e.g. 'reports/q3.md'. No leading '/', no '..'.",
  );

const inputSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("read").describe("Read a text file, paginated by lines."),
    path: pathSchema,
    offset_line: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("0-based first line to return. Defaults to 0."),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Max lines to return. Defaults to 2000."),
  }),
  z.object({
    op: z
      .literal("write")
      .describe("Create or overwrite a text file (UTF-8, max 512 KiB)."),
    path: pathSchema,
    content: z
      .string()
      .max(WORKSPACE_FS_LIMITS.maxFileBytes)
      .describe("Full file content to write."),
    expected_version: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Reject the write unless the file is still at this version."),
  }),
  z.object({
    op: z
      .literal("edit")
      .describe(
        "Replace an exact snippet inside an existing file. Prefer this over rewriting whole files.",
      ),
    path: pathSchema,
    old_text: z
      .string()
      .min(1)
      .max(WORKSPACE_FS_LIMITS.maxFileBytes)
      .describe("Exact text to replace; must match the file content verbatim."),
    new_text: z.string().max(WORKSPACE_FS_LIMITS.maxFileBytes),
    replace_all: z
      .boolean()
      .optional()
      .describe("Replace every occurrence instead of failing when ambiguous."),
    expected_version: z.number().int().min(1).optional(),
  }),
  z.object({
    op: z.literal("list").describe("List files under a directory prefix."),
    path: z
      .string()
      .max(WORKSPACE_FS_LIMITS.maxPathLength)
      .optional()
      .describe("Directory prefix. Omit for the whole workspace."),
  }),
  z.object({
    op: z.literal("move").describe("Rename or move a file."),
    from_path: pathSchema,
    to_path: pathSchema,
    expected_version: z.number().int().min(1).optional(),
  }),
  z.object({
    op: z.literal("delete").describe("Delete a file."),
    path: pathSchema,
  }),
  z.object({
    op: z
      .literal("search")
      .describe("Find files by name glob and/or content substring."),
    glob: z
      .string()
      .max(256)
      .optional()
      .describe("Glob pattern, e.g. 'docs/**/*.md'."),
    grep: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("Case-insensitive content substring."),
    path: z.string().max(WORKSPACE_FS_LIMITS.maxPathLength).optional(),
    case_sensitive: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("stat").describe("Get metadata (size, version) for a file."),
    path: pathSchema,
  }),
  z.object({
    op: z
      .literal("export")
      .describe(
        "Copy a workspace file into downloadable storage and return a link the user can click to download it. Use this when the user asks for a file or a download link.",
      ),
    path: pathSchema,
  }),
  z.object({
    op: z
      .literal("import_artifact")
      .describe("Copy an existing text artifact into the workspace."),
    artifact_id: z.string().uuid().describe("Artifact ID to import."),
    path: pathSchema,
  }),
]);

/**
 * Scoped virtual filesystem for the chat agent. The agent runtime context
 * (userId, workspaceId, taskId) is read from the tool execute options
 * context, so files are jailed to the run's scope (task > workspace >
 * global) and owned by the session user. There is no host filesystem access
 * and no code execution — the tool API itself is the security boundary.
 */
export function createWorkspaceFsTool() {
  return createTool({
    description:
      "Read, create, edit, list, move, delete, and search text files in the " +
      "current scoped workspace. Files persist across the conversation for " +
      "this task/workspace. Content is UTF-8 text only (max 512 KiB per " +
      "file). Use 'edit' with an exact snippet for small changes, 'read' " +
      "with offset/limit for large files, and 'search' to discover paths.",
    inputSchema,
    execute: async (input, options) => {
      // SAFETY: IrisHarness passes AgentRuntimeContext as the AI SDK tool
      // execute options context; the userId guard below fails closed when it
      // is missing.
      const runtimeContext = options?.context as
        | AgentRuntimeContext
        | undefined;
      if (!runtimeContext?.userId)
        return {
          ok: false as const,
          error: "REPOSITORY_FAILURE" as const,
          message:
            "Workspace filesystem is unavailable: no agent runtime context.",
        };
      const scope = {
        userId: runtimeContext.userId,
        workspaceId: runtimeContext.workspaceId,
        taskId: runtimeContext.taskId,
      } as const;

      switch (input.op) {
        case "read":
          return await service.read({
            scope,
            path: input.path,
            offsetLine: input.offset_line,
            limit: input.limit,
          });
        case "write":
          return await service.write({
            scope,
            path: input.path,
            content: input.content,
            expectedVersion: input.expected_version,
          });
        case "edit":
          return await service.edit({
            scope,
            path: input.path,
            oldText: input.old_text,
            newText: input.new_text,
            replaceAll: input.replace_all,
            expectedVersion: input.expected_version,
          });
        case "list":
          return await service.list({ scope, path: input.path });
        case "move":
          return await service.move({
            scope,
            fromPath: input.from_path,
            toPath: input.to_path,
            expectedVersion: input.expected_version,
          });
        case "delete":
          return await service.remove({ scope, path: input.path });
        case "search":
          return await service.search({
            scope,
            glob: input.glob,
            grep: input.grep,
            path: input.path,
            caseSensitive: input.case_sensitive,
          });
        case "stat":
          return await service.stat({ scope, path: input.path });
        case "export":
          return await service.exportFile({
            scope,
            path: input.path,
            createArtifact: async (file) => {
              const reference = await artifactService.create({
                content: file.content,
                filename: file.filename,
                mediaType: file.mediaType,
                userId: file.userId,
                runId: runtimeContext.runId,
              });
              return {
                artifactId: reference.artifactId,
                filename: reference.filename,
                mediaType: reference.mediaType,
                size: reference.size,
                sha256: reference.sha256,
              };
            },
          });
        case "import_artifact": {
          const artifact = await artifactLoader(input.artifact_id);
          if (!artifact)
            return {
              ok: false as const,
              error: "ARTIFACT_NOT_FOUND" as const,
              message: `No artifact found with id ${input.artifact_id}.`,
            };
          if (artifact.size > WORKSPACE_FS_LIMITS.maxImportBytes)
            return {
              ok: false as const,
              error: "ARTIFACT_TOO_LARGE" as const,
              message: `Artifact is ${artifact.size} bytes; the import limit is ${WORKSPACE_FS_LIMITS.maxImportBytes} bytes.`,
            };
          if (!artifact.utf8)
            return {
              ok: false as const,
              error: "ARTIFACT_UNSUPPORTED" as const,
              message:
                "Artifact is not UTF-8 text; only text artifacts can be imported into the workspace.",
            };
          return await service.write({
            scope,
            path: input.path,
            content: artifact.content,
          });
        }
      }
    },
  });
}

async function artifactLoader(
  artifactId: string,
): Promise<{ content: string; size: number; utf8: boolean } | null> {
  const artifact = await artifactRepository.selectById(artifactId);
  if (!artifact) return null;
  const storage =
    artifact.storageProfileId && "withProfile" in serverFileStorage
      ? (
          serverFileStorage as FileStorage & {
            withProfile(id: string): FileStorage;
          }
        ).withProfile(artifact.storageProfileId)
      : serverFileStorage;
  const bytes = await storage.download(artifact.storageKey);
  const size = bytes.byteLength;
  if (size > WORKSPACE_FS_LIMITS.maxImportBytes)
    return { content: "", size, utf8: false };
  const content = bytes.toString("utf8");
  const utf8 = Buffer.compare(bytes, Buffer.from(content, "utf8")) === 0;
  return { content, size, utf8 };
}
