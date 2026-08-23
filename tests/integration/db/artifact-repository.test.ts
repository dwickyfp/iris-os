import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { applyMigrations, recreatePublicSchema } from "./migration-harness";

const connectionString = process.env.TEST_POSTGRES_URL;
if (!connectionString) throw new Error("TEST_POSTGRES_URL is required");
process.env.POSTGRES_URL = connectionString;

vi.mock("server-only", () => ({}));

const client = new Client({ connectionString });
const loadArtifactRepositoryModule = () =>
  import("lib/db/pg/repositories/artifact-repository.pg");
type ArtifactRepositoryModule = Awaited<
  ReturnType<typeof loadArtifactRepositoryModule>
>;
let artifactRepository: ArtifactRepositoryModule["pgArtifactRepository"];

beforeAll(async () => {
  await client.connect();
  await recreatePublicSchema(client);
  await applyMigrations(client);
  artifactRepository = (
    await import("lib/db/pg/repositories/artifact-repository.pg")
  ).pgArtifactRepository;
});

afterAll(async () => {
  await recreatePublicSchema(client);
  await client.end();
});

describe("artifact repository cleanup", () => {
  test("claims cleanup for a storage key with no artifact row", async () => {
    const cleanupId = await artifactRepository.scheduleUploadCleanup(
      `orphan/${randomUUID()}`,
    );
    await client.query(
      `UPDATE artifact_cleanup SET next_attempt_at = NOW() - interval '1 second'
       WHERE id = $1`,
      [cleanupId],
    );

    const claimed = await artifactRepository.claimCleanup({
      before: new Date(),
      limit: 1,
    });
    expect(claimed).toEqual([
      expect.objectContaining({ cleanupId, artifactId: undefined }),
    ]);
  });
});
