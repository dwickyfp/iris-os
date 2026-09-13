import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { applyMigrations, recreatePublicSchema } from "./migration-harness";

const connectionString = process.env.TEST_POSTGRES_URL;
if (!connectionString) throw new Error("TEST_POSTGRES_URL is required");
process.env.POSTGRES_URL = connectionString;

vi.mock("server-only", () => ({}));

const client = new Client({ connectionString });
const loadWorkspaceFileRepositoryModule = () =>
  import("lib/db/pg/repositories/workspace-file-repository.pg");
type WorkspaceFileRepositoryModule = Awaited<
  ReturnType<typeof loadWorkspaceFileRepositoryModule>
>;
let workspaceFileRepository: WorkspaceFileRepositoryModule["pgWorkspaceFileRepository"];

async function seedUser(userId: string) {
  await client.query(
    `INSERT INTO "user" (id, name, email, password)
     VALUES ($1, 'Test User', $2, 'x') ON CONFLICT DO NOTHING`,
    [userId, `${userId}@test.local`],
  );
}

async function seedWorkspace(userId: string, workspaceId: string) {
  await client.query(
    `INSERT INTO "workspace" (id, user_id, name, slug, status)
     VALUES ($1, $2, 'Test Workspace', $3, 'active') ON CONFLICT DO NOTHING`,
    [workspaceId, userId, workspaceId.slice(0, 40)],
  );
}

beforeAll(async () => {
  await client.connect();
  await recreatePublicSchema(client);
  await applyMigrations(client);
  workspaceFileRepository = (
    await import("lib/db/pg/repositories/workspace-file-repository.pg")
  ).pgWorkspaceFileRepository;
});

afterAll(async () => {
  await recreatePublicSchema(client);
  await client.end();
});

describe("workspace file repository", () => {
  test("create, select, update, move, delete round trip", async () => {
    const userId = randomUUID();
    await seedUser(userId);

    const created = await workspaceFileRepository.create({
      userId,
      scopeKey: "global",
      path: "notes/first.md",
      filename: "first.md",
      mediaType: "text/markdown",
      content: "# Hello\n",
      size: 8,
      sha256: "a".repeat(64),
    });
    expect(created.version).toBe(1);
    expect(created.content).toBe("# Hello\n");

    const selected = await workspaceFileRepository.selectByPath(
      userId,
      "global",
      "notes/first.md",
    );
    expect(selected?.id).toBe(created.id);

    const updated = await workspaceFileRepository.updateContent({
      userId,
      scopeKey: "global",
      path: "notes/first.md",
      expectedVersion: 1,
      mediaType: "text/markdown",
      content: "# Hello\n\nMore.\n",
      size: 15,
      sha256: "b".repeat(64),
    });
    expect(updated.version).toBe(2);

    const moved = await workspaceFileRepository.move({
      userId,
      scopeKey: "global",
      fromPath: "notes/first.md",
      toPath: "docs/first.md",
      expectedVersion: 2,
    });
    expect(moved.path).toBe("docs/first.md");
    expect(moved.version).toBe(3);
    expect(
      await workspaceFileRepository.selectByPath(
        userId,
        "global",
        "notes/first.md",
      ),
    ).toBeNull();

    expect(
      await workspaceFileRepository.deletePath(
        userId,
        "global",
        "docs/first.md",
      ),
    ).toBe(true);
    expect(
      await workspaceFileRepository.selectByPath(
        userId,
        "global",
        "docs/first.md",
      ),
    ).toBeNull();
  });

  test("enforces unique (user, scope, path) with PATH_EXISTS", async () => {
    const userId = randomUUID();
    await seedUser(userId);
    const input = {
      userId,
      scopeKey: "global",
      path: "dupe.txt",
      filename: "dupe.txt",
      mediaType: "text/plain",
      content: "x",
      size: 1,
      sha256: "c".repeat(64),
    };
    await workspaceFileRepository.create(input);
    await expect(workspaceFileRepository.create(input)).rejects.toMatchObject({
      code: "PATH_EXISTS",
    });
  });

  test("updateContent reports PATH_NOT_FOUND and VERSION_CONFLICT", async () => {
    const userId = randomUUID();
    await seedUser(userId);
    await expect(
      workspaceFileRepository.updateContent({
        userId,
        scopeKey: "global",
        path: "missing.txt",
        expectedVersion: 1,
        mediaType: "text/plain",
        content: "x",
        size: 1,
        sha256: "d".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" });

    await workspaceFileRepository.create({
      userId,
      scopeKey: "global",
      path: "v.txt",
      filename: "v.txt",
      mediaType: "text/plain",
      content: "x",
      size: 1,
      sha256: "e".repeat(64),
    });
    await expect(
      workspaceFileRepository.updateContent({
        userId,
        scopeKey: "global",
        path: "v.txt",
        expectedVersion: 7,
        mediaType: "text/plain",
        content: "y",
        size: 1,
        sha256: "f".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  test("scopes list, search, and usage to the user scope", async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const workspaceId = randomUUID();
    await seedUser(userId);
    await seedUser(otherUserId);
    await seedWorkspace(userId, workspaceId);

    await workspaceFileRepository.create({
      userId,
      scopeKey: `workspace:${workspaceId}`,
      workspaceId,
      path: "a.md",
      filename: "a.md",
      mediaType: "text/markdown",
      content: "needle in haystack",
      size: 18,
      sha256: "1".repeat(64),
    });
    await workspaceFileRepository.create({
      userId,
      scopeKey: "global",
      path: "b.md",
      filename: "b.md",
      mediaType: "text/markdown",
      content: "needle elsewhere",
      size: 16,
      sha256: "2".repeat(64),
    });
    await workspaceFileRepository.create({
      userId: otherUserId,
      scopeKey: "global",
      path: "c.md",
      filename: "c.md",
      mediaType: "text/markdown",
      content: "needle owned by someone else",
      size: 28,
      sha256: "3".repeat(64),
    });

    const listed = await workspaceFileRepository.listMetadata(
      userId,
      `workspace:${workspaceId}`,
    );
    expect(listed.map((entry) => entry.path)).toEqual(["a.md"]);

    const searched = await workspaceFileRepository.searchContent(
      userId,
      "global",
      "needle",
      10,
    );
    expect(searched.map((entry) => entry.path)).toEqual(["b.md"]);

    const usage = await workspaceFileRepository.usage(
      userId,
      `workspace:${workspaceId}`,
    );
    expect(usage).toEqual({ fileCount: 1, totalSize: 18 });
  });

  test("escapes LIKE metacharacters in prefix and search", async () => {
    const userId = randomUUID();
    await seedUser(userId);
    await workspaceFileRepository.create({
      userId,
      scopeKey: "global",
      path: "a%b.txt",
      filename: "a%b.txt",
      mediaType: "text/plain",
      content: "100% done",
      size: 9,
      sha256: "4".repeat(64),
    });
    const listed = await workspaceFileRepository.listMetadata(
      userId,
      "global",
      "a%",
    );
    expect(listed.map((entry) => entry.path)).toEqual(["a%b.txt"]);
    const searched = await workspaceFileRepository.searchContent(
      userId,
      "global",
      "0% do",
      10,
    );
    expect(searched).toHaveLength(1);
  });
});
