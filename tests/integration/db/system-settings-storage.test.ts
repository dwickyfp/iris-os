import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { applyMigrations, recreatePublicSchema } from "./migration-harness";

const connectionString = process.env.TEST_POSTGRES_URL;
if (!connectionString) throw new Error("TEST_POSTGRES_URL is required");
process.env.POSTGRES_URL = connectionString;
process.env.IRIS_ROOT_ENCRYPTION_KEY = randomBytes(32).toString("base64");
vi.mock("server-only", () => ({}));

const client = new Client({ connectionString });

beforeAll(async () => {
  await client.connect();
  await recreatePublicSchema(client);
  await applyMigrations(client);
});

afterAll(async () => {
  await recreatePublicSchema(client);
  await client.end();
});

describe("system settings and storage profiles", () => {
  test("encrypts settings with optimistic revisions and atomic audit", async () => {
    const userId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Settings Admin', $2, 'hash')`,
      [userId, `settings-${userId}@example.test`],
    );
    const { createSystemSettingsService, SystemSettingRevisionConflictError } =
      await import("lib/system-settings/service");
    const { pgSystemSettingsRepository } = await import(
      "lib/db/pg/repositories/system-settings-repository.pg"
    );
    const service = createSystemSettingsService(pgSystemSettingsRepository);
    const created = await service.mutate(
      { operation: "set", key: "exa.apiKey", value: "secret-value" },
      userId,
      0,
    );
    expect(created).toMatchObject({
      configured: true,
      redacted: true,
      revision: 1,
    });
    await expect(service.getSecret("exa.apiKey")).resolves.toBe("secret-value");
    await expect(
      service.mutate(
        { operation: "set", key: "exa.apiKey", value: "stale" },
        userId,
        0,
      ),
    ).rejects.toBeInstanceOf(SystemSettingRevisionConflictError);
    const persisted = await client.query(
      `SELECT value, encrypted_value, encryption_key_id
       FROM system_setting WHERE key = 'exa.apiKey'`,
    );
    expect(persisted.rows[0].value).toBeNull();
    expect(persisted.rows[0].encrypted_value).not.toContain("secret-value");
    expect(persisted.rows[0].encryption_key_id).toBe("root-v1");
    const audit = await client.query(
      `SELECT count(*)::int AS count FROM system_setting_audit
       WHERE key = 'exa.apiKey'`,
    );
    expect(audit.rows[0].count).toBe(1);
  });

  test("activates immutable profiles and backfills legacy artifact locations", async () => {
    const userId = randomUUID();
    const runId = randomUUID();
    const artifactId = randomUUID();
    const profileId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Storage Admin', $2, 'hash')`,
      [userId, `storage-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO agent_run (id, user_id, root_run_id, status)
       VALUES ($1, $2, $1, 'succeeded')`,
      [runId, userId],
    );
    await client.query(
      `INSERT INTO artifact
        (id, user_id, run_id, storage_key, filename, media_type, size, sha256)
       VALUES ($1, $2, $3, 'legacy/a.txt', 'a.txt', 'text/plain', 1, $4)`,
      [artifactId, userId, runId, "a".repeat(64)],
    );
    const { pgStorageProfileRepository } = await import(
      "lib/db/pg/repositories/storage-profile-repository.pg"
    );
    const { encryptSystemSettingValue } = await import(
      "lib/security/encrypted-value"
    );
    await pgStorageProfileRepository.create({
      id: profileId,
      name: "Initial MinIO",
      driver: "minio",
      actorId: userId,
      s3: {
        endpoint: "http://minio:9000",
        region: "us-east-1",
        bucket: "iris",
        accessKeyId: "access",
        secretAccessKey: "secret",
      },
      encryptedAccessKey: encryptSystemSettingValue(
        `fileStorage.profile.${profileId}.accessKey`,
        "access",
      ),
      encryptedSecretKey: encryptSystemSettingValue(
        `fileStorage.profile.${profileId}.secretKey`,
        "secret",
      ),
    });
    await pgStorageProfileRepository.activate(profileId, userId, {
      adoptLegacyObjects: true,
    });
    const artifact = await client.query(
      `SELECT storage_profile_id FROM artifact WHERE id = $1`,
      [artifactId],
    );
    expect(artifact.rows[0].storage_profile_id).toBe(profileId);
    expect((await pgStorageProfileRepository.getActive())?.id).toBe(profileId);
  });

  test("fences durable jobs and persists completion outbox", async () => {
    const { pgDurableJobRepository } = await import("lib/jobs/repository.pg");
    const userId = randomUUID();
    const runId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Job Owner', $2, 'hash')`,
      [userId, `job-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO agent_run (id, user_id, root_run_id, status)
       VALUES ($1, $2, $1, 'succeeded')`,
      [runId, userId],
    );
    const id = `job-${randomUUID()}`;
    const created = await pgDurableJobRepository.create({
      id,
      idempotencyKey: `orchestration:${id}`,
      target: { kind: "job", jobType: "capability-orchestration" },
      payload: { steps: [] },
      runInbox: { runId, correlationId: `correlation-${id}` },
    });
    expect(created.kind).toBe("created");
    const lease = await pgDurableJobRepository.claim({
      workerId: "worker-1",
      leaseDurationMs: 30_000,
    });
    expect(lease?.job.id).toBe(id);
    const finished = await pgDurableJobRepository.finish({
      jobId: id,
      leaseToken: lease!.token,
      outcome: { status: "completed", result: { ok: true } },
    });
    expect(finished.kind).toBe("applied");
    const outbox = await client.query(
      `SELECT count(*)::int AS count
       FROM durable_job_completion_outbox WHERE job_id = $1`,
      [id],
    );
    expect(outbox.rows[0].count).toBe(1);
    await expect(
      pgDurableJobRepository.finish({
        jobId: id,
        leaseToken: randomUUID(),
        outcome: { status: "completed", result: { ok: false } },
      }),
    ).resolves.toMatchObject({ kind: "lease_lost" });
  });
});
