import { describe, expect, test } from "vitest";
import type { WorkspaceScope } from "./contracts";
import { createInMemoryWorkspaceFileRepository } from "./in-memory-repository";
import { WORKSPACE_FS_LIMITS } from "./limits";
import type { WorkspaceFsLimits } from "./limits";
import { WorkspaceFileService } from "./service";

const scope: WorkspaceScope = { userId: "user-1" };

function makeService(
  overrides: Partial<WorkspaceFsLimits> = {},
): WorkspaceFileService {
  return new WorkspaceFileService(createInMemoryWorkspaceFileRepository(), {
    ...WORKSPACE_FS_LIMITS,
    ...overrides,
  });
}

function expectFail(
  result: { ok: boolean; error?: string },
  error: string,
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBe(error);
}

describe("WorkspaceFileService.write", () => {
  test("creates a new file at version 1", async () => {
    const service = makeService();
    const result = await service.write({
      scope,
      path: "notes/first.md",
      content: "# Hello\n",
    });
    expect(result).toMatchObject({
      ok: true,
      path: "notes/first.md",
      created: true,
      version: 1,
      size: 8,
      mediaType: "text/markdown",
    });
  });

  test("overwrites an existing file and bumps the version", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.txt", content: "one" });
    const result = await service.write({
      scope,
      path: "a.txt",
      content: "two!",
    });
    expect(result).toMatchObject({
      ok: true,
      created: false,
      version: 2,
      size: 4,
    });
  });

  test("rejects a stale expectedVersion with VERSION_CONFLICT", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.txt", content: "one" });
    await service.write({ scope, path: "a.txt", content: "two" });
    const result = await service.write({
      scope,
      path: "a.txt",
      content: "three",
      expectedVersion: 1,
    });
    expectFail(result, "VERSION_CONFLICT");
  });

  test("accepts the current expectedVersion", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.txt", content: "one" });
    const result = await service.write({
      scope,
      path: "a.txt",
      content: "two",
      expectedVersion: 1,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects oversized content with FILE_TOO_LARGE", async () => {
    const service = makeService({ maxFileBytes: 10 });
    const result = await service.write({
      scope,
      path: "big.txt",
      content: "x".repeat(11),
    });
    expectFail(result, "FILE_TOO_LARGE");
  });

  test("rejects invalid paths with PATH_INVALID", async () => {
    const service = makeService();
    const result = await service.write({
      scope,
      path: "../escape.txt",
      content: "nope",
    });
    expectFail(result, "PATH_INVALID");
  });

  test("enforces the per-scope file count quota", async () => {
    const service = makeService({ maxFiles: 2 });
    await service.write({ scope, path: "a.txt", content: "a" });
    await service.write({ scope, path: "b.txt", content: "b" });
    const result = await service.write({ scope, path: "c.txt", content: "c" });
    expectFail(result, "QUOTA_FILE_COUNT");
  });

  test("enforces the per-scope byte quota", async () => {
    const service = makeService({ maxTotalBytes: 15, maxFiles: 100 });
    await service.write({ scope, path: "a.txt", content: "x".repeat(10) });
    const result = await service.write({
      scope,
      path: "b.txt",
      content: "y".repeat(6),
    });
    expectFail(result, "QUOTA_EXCEEDED");
  });

  test("overwrites do not count against file count quota", async () => {
    const service = makeService({ maxFiles: 1 });
    await service.write({ scope, path: "a.txt", content: "a" });
    const result = await service.write({ scope, path: "a.txt", content: "bb" });
    expect(result.ok).toBe(true);
  });
});

describe("WorkspaceFileService.read", () => {
  test("returns the whole file with line metadata", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.md", content: "one\ntwo\nthree" });
    const result = await service.read({ scope, path: "a.md" });
    expect(result).toMatchObject({
      ok: true,
      content: "one\ntwo\nthree",
      totalLines: 3,
      startLine: 0,
      endLine: 2,
      truncated: false,
    });
  });

  test("paginates by line offset and limit", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.md", content: "1\n2\n3\n4\n5" });
    const result = await service.read({
      scope,
      path: "a.md",
      offsetLine: 2,
      limit: 2,
    });
    expect(result).toMatchObject({
      ok: true,
      content: "3\n4",
      totalLines: 5,
      startLine: 2,
      endLine: 3,
      truncated: true,
    });
  });

  test("caps read output at maxReadOutputBytes", async () => {
    const service = makeService({ maxReadOutputBytes: 10, maxReadLines: 100 });
    await service.write({
      scope,
      path: "a.md",
      content: "123456\n123456\n123456",
    });
    const result = await service.read({ scope, path: "a.md" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe("123456");
      expect(result.truncated).toBe(true);
    }
  });

  test("reports PATH_NOT_FOUND for missing files", async () => {
    const service = makeService();
    const result = await service.read({ scope, path: "missing.txt" });
    expectFail(result, "PATH_NOT_FOUND");
  });
});

describe("WorkspaceFileService.edit", () => {
  test("replaces the first occurrence and bumps version", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.md", content: "hello world" });
    const result = await service.edit({
      scope,
      path: "a.md",
      oldText: "world",
      newText: "there",
    });
    expect(result).toMatchObject({ ok: true, version: 2, occurrences: 1 });
    const read = await service.read({ scope, path: "a.md" });
    expect(read.ok && read.content).toBe("hello there");
  });

  test("reports EDIT_NOT_FOUND when oldText is absent", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.md", content: "hello" });
    const result = await service.edit({
      scope,
      path: "a.md",
      oldText: "missing",
      newText: "x",
    });
    expectFail(result, "EDIT_NOT_FOUND");
  });

  test("reports EDIT_AMBIGUOUS without replaceAll", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.md", content: "x x x" });
    const result = await service.edit({
      scope,
      path: "a.md",
      oldText: "x",
      newText: "y",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("EDIT_AMBIGUOUS");
      expect(result.occurrences).toBe(3);
    }
  });

  test("replaceAll replaces every occurrence", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.md", content: "x x x" });
    const result = await service.edit({
      scope,
      path: "a.md",
      oldText: "x",
      newText: "y",
      replaceAll: true,
    });
    expect(result.ok).toBe(true);
    const read = await service.read({ scope, path: "a.md" });
    expect(read.ok && read.content).toBe("y y y");
  });

  test("rejects an edit that would exceed the file size limit", async () => {
    const service = makeService({ maxFileBytes: 10 });
    await service.write({ scope, path: "a.md", content: "12345" });
    const result = await service.edit({
      scope,
      path: "a.md",
      oldText: "12345",
      newText: "y".repeat(11),
    });
    expectFail(result, "FILE_TOO_LARGE");
  });

  test("honors expectedVersion for concurrency control", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.md", content: "hello" });
    const result = await service.edit({
      scope,
      path: "a.md",
      oldText: "hello",
      newText: "hi",
      expectedVersion: 5,
    });
    expectFail(result, "VERSION_CONFLICT");
  });
});

describe("WorkspaceFileService.list", () => {
  test("lists entries sorted by path with a truncation flag", async () => {
    const service = makeService();
    await service.write({ scope, path: "b.txt", content: "b" });
    await service.write({ scope, path: "a/c.txt", content: "ac" });
    await service.write({ scope, path: "a.txt", content: "a" });
    const result = await service.list({ scope });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries.map((entry) => entry.path)).toEqual([
        "a.txt",
        "a/c.txt",
        "b.txt",
      ]);
      expect(result.truncated).toBe(false);
      expect(result.total).toBe(3);
    }
  });

  test("filters by directory prefix", async () => {
    const service = makeService();
    await service.write({ scope, path: "docs/a.md", content: "a" });
    await service.write({ scope, path: "docs/deep/b.md", content: "b" });
    await service.write({ scope, path: "src/c.ts", content: "c" });
    const result = await service.list({ scope, path: "docs" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries.map((entry) => entry.path)).toEqual([
        "docs/a.md",
        "docs/deep/b.md",
      ]);
    }
  });

  test("respects maxListEntries and reports truncation", async () => {
    const service = makeService({ maxListEntries: 2 });
    await service.write({ scope, path: "a.txt", content: "a" });
    await service.write({ scope, path: "b.txt", content: "b" });
    await service.write({ scope, path: "c.txt", content: "c" });
    const result = await service.list({ scope });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toHaveLength(2);
      expect(result.truncated).toBe(true);
      expect(result.total).toBe(3);
    }
  });
});

describe("WorkspaceFileService.move", () => {
  test("moves a file and bumps the version", async () => {
    const service = makeService();
    await service.write({ scope, path: "old/name.txt", content: "data" });
    const result = await service.move({
      scope,
      fromPath: "old/name.txt",
      toPath: "new/name.txt",
    });
    expect(result).toMatchObject({
      ok: true,
      fromPath: "old/name.txt",
      toPath: "new/name.txt",
      version: 2,
    });
    const gone = await service.read({ scope, path: "old/name.txt" });
    expect(gone.ok).toBe(false);
    const moved = await service.read({ scope, path: "new/name.txt" });
    expect(moved.ok && moved.content).toBe("data");
  });

  test("reports PATH_NOT_FOUND for a missing source", async () => {
    const service = makeService();
    const result = await service.move({
      scope,
      fromPath: "nope.txt",
      toPath: "new.txt",
    });
    expectFail(result, "PATH_NOT_FOUND");
  });

  test("reports PATH_EXISTS when the target is taken", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.txt", content: "a" });
    await service.write({ scope, path: "b.txt", content: "b" });
    const result = await service.move({
      scope,
      fromPath: "a.txt",
      toPath: "b.txt",
    });
    expectFail(result, "PATH_EXISTS");
  });
});

describe("WorkspaceFileService.remove", () => {
  test("deletes an existing file", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.txt", content: "a" });
    const result = await service.remove({ scope, path: "a.txt" });
    expect(result).toMatchObject({ ok: true, deleted: true });
  });

  test("reports deleted=false for a missing file", async () => {
    const service = makeService();
    const result = await service.remove({ scope, path: "nope.txt" });
    expect(result).toMatchObject({ ok: true, deleted: false });
  });
});

describe("WorkspaceFileService.stat", () => {
  test("returns metadata without content", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.md", content: "hello" });
    const result = await service.stat({ scope, path: "a.md" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.path).toBe("a.md");
      expect(result.entry.size).toBe(5);
      expect(result.entry.version).toBe(1);
      expect("content" in result.entry).toBe(false);
    }
  });

  test("reports PATH_NOT_FOUND for missing files", async () => {
    const service = makeService();
    const result = await service.stat({ scope, path: "nope.txt" });
    expectFail(result, "PATH_NOT_FOUND");
  });
});

describe("WorkspaceFileService.search", () => {
  const seed = async (service: WorkspaceFileService) => {
    await service.write({
      scope,
      path: "docs/api.md",
      content: "# API\nrate limit is 10\nSee guide\n",
    });
    await service.write({
      scope,
      path: "docs/guide.md",
      content: "# Guide\nRate Limit details\nunrelated\n",
    });
    await service.write({
      scope,
      path: "src/app.ts",
      content: "const rate = 10;\n",
    });
  };

  test("searches content case-insensitively by default", async () => {
    const service = makeService();
    await seed(service);
    const result = await service.search({ scope, grep: "rate limit" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.map((file) => file.path)).toEqual([
        "docs/api.md",
        "docs/guide.md",
      ]);
      expect(result.files[0]?.lineMatches[0]).toMatchObject({
        lineNumber: 2,
        text: "rate limit is 10",
      });
    }
  });

  test("supports case-sensitive matching", async () => {
    const service = makeService();
    await seed(service);
    const result = await service.search({
      scope,
      grep: "Rate Limit",
      caseSensitive: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.map((file) => file.path)).toEqual(["docs/guide.md"]);
    }
  });

  test("filters by glob pattern", async () => {
    const service = makeService();
    await seed(service);
    const result = await service.search({ scope, glob: "src/*.ts" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.map((file) => file.path)).toEqual(["src/app.ts"]);
    }
  });

  test("combines glob and grep", async () => {
    const service = makeService();
    await seed(service);
    const result = await service.search({
      scope,
      glob: "docs/*.md",
      grep: "rate",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.map((file) => file.path)).toEqual([
        "docs/api.md",
        "docs/guide.md",
      ]);
    }
  });

  test("caps line matches per file and total files", async () => {
    const service = makeService({
      maxSearchMatches: 2,
      maxSearchLinesPerFile: 2,
    });
    await service.write({
      scope,
      path: "log.txt",
      content: Array.from({ length: 10 }, (_, i) => `hit ${i}`).join("\n"),
    });
    const result = await service.search({ scope, grep: "hit" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files[0]?.lineMatches).toHaveLength(2);
      expect(result.files[0]?.totalMatches).toBe(10);
      expect(result.truncated).toBe(true);
    }
  });

  test("rejects a search with neither glob nor grep", async () => {
    const service = makeService();
    const result = await service.search({ scope });
    expectFail(result, "SEARCH_EMPTY");
  });

  test("scopes results to the requesting scope only", async () => {
    const service = makeService();
    await seed(service);
    const otherScope: WorkspaceScope = {
      userId: "user-1",
      workspaceId: "ws-9",
    };
    const result = await service.search({ scope: otherScope, grep: "rate" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.files).toHaveLength(0);
  });
});

describe("WorkspaceFileService.usage", () => {
  test("reports file count and total size per scope", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.txt", content: "12345" });
    await service.write({ scope, path: "b.txt", content: "123" });
    const result = await service.usage({ scope });
    expect(result).toMatchObject({
      ok: true,
      fileCount: 2,
      totalSize: 8,
    });
  });
});

describe("WorkspaceFileService.exportFile", () => {
  const createArtifact =
    (captured: Array<Record<string, unknown>>) =>
    async (file: {
      content: string;
      filename: string;
      mediaType: string;
      userId: string;
    }) => {
      captured.push(file);
      return {
        artifactId: "artifact-1",
        filename: file.filename,
        mediaType: file.mediaType,
        size: Buffer.byteLength(file.content, "utf8"),
        sha256: "a".repeat(64),
      };
    };

  test("copies the file and returns a download URL", async () => {
    const service = makeService();
    await service.write({ scope, path: "reports/q3.md", content: "# Q3\n" });
    const captured: Array<Record<string, unknown>> = [];
    const result = await service.exportFile({
      scope,
      path: "reports/q3.md",
      createArtifact: createArtifact(captured),
    });
    expect(result).toMatchObject({
      ok: true,
      path: "reports/q3.md",
      artifactId: "artifact-1",
      filename: "q3.md",
      mediaType: "text/markdown",
      size: 5,
      version: 1,
      downloadUrl: "/api/artifacts/artifact-1",
    });
    expect(captured[0]).toMatchObject({
      content: "# Q3\n",
      filename: "q3.md",
      userId: "user-1",
    });
  });

  test("uses the injected download URL builder when provided", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.txt", content: "x" });
    const result = await service.exportFile({
      scope,
      path: "a.txt",
      createArtifact: createArtifact([]),
      downloadUrl: (artifactId) => `https://cdn.example/${artifactId}`,
    });
    expect(result.ok && result.downloadUrl).toBe(
      "https://cdn.example/artifact-1",
    );
  });

  test("reports PATH_NOT_FOUND without calling the artifact creator", async () => {
    const service = makeService();
    const captured: Array<Record<string, unknown>> = [];
    const result = await service.exportFile({
      scope,
      path: "missing.md",
      createArtifact: createArtifact(captured),
    });
    expectFail(result, "PATH_NOT_FOUND");
    expect(captured).toHaveLength(0);
  });

  test("reports PATH_INVALID for a traversing path", async () => {
    const service = makeService();
    const result = await service.exportFile({
      scope,
      path: "../secret",
      createArtifact: createArtifact([]),
    });
    expectFail(result, "PATH_INVALID");
  });

  test("surfaces storage failures as EXPORT_FAILED", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.txt", content: "x" });
    const result = await service.exportFile({
      scope,
      path: "a.txt",
      createArtifact: async () => {
        throw new Error("bucket unavailable");
      },
    });
    expectFail(result, "EXPORT_FAILED");
  });

  test("does not export a file owned by another user", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.txt", content: "mine" });
    const otherUser: WorkspaceScope = { userId: "user-2" };
    const result = await service.exportFile({
      scope: otherUser,
      path: "a.txt",
      createArtifact: createArtifact([]),
    });
    expectFail(result, "PATH_NOT_FOUND");
  });
});

describe("scope isolation", () => {
  test("same path in different scopes is a different file", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.txt", content: "global" });
    const wsScope: WorkspaceScope = { userId: "user-1", workspaceId: "ws-1" };
    const result = await service.write({
      scope: wsScope,
      path: "a.txt",
      content: "workspace",
    });
    expect(result.ok).toBe(true);
    const globalRead = await service.read({ scope, path: "a.txt" });
    expect(globalRead.ok && globalRead.content).toBe("global");
  });

  test("another user cannot read the same scope path", async () => {
    const service = makeService();
    await service.write({ scope, path: "a.txt", content: "mine" });
    const otherUser: WorkspaceScope = { userId: "user-2" };
    const result = await service.read({ scope: otherUser, path: "a.txt" });
    expectFail(result, "PATH_NOT_FOUND");
  });
});
