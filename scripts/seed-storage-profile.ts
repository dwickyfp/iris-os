import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { pgStorageProfileRepository } from "lib/db/pg/repositories/storage-profile-repository.pg";
import { encryptSystemSettingValue } from "lib/security/encrypted-value";
import { createProfileStorage } from "lib/file-storage/storage-router";

/**
 * Create (or reuse) and activate a MinIO/S3-compatible storage profile, then
 * run the same put/head/get/delete probe as the admin "Test" action.
 *
 * Required env: IRIS_ROOT_ENCRYPTION_KEY, POSTGRES_URL,
 * MINIO_ENDPOINT (default http://localhost:9000),
 * MINIO_ROOT_USER, MINIO_ROOT_PASSWORD, MINIO_BUCKET (default iris).
 */

const name = process.env.STORAGE_PROFILE_NAME ?? "local-minio";
const endpoint = process.env.MINIO_ENDPOINT ?? "http://localhost:9000";
const bucket = process.env.MINIO_BUCKET ?? "iris";
const region = process.env.MINIO_REGION ?? "us-east-1";
const accessKeyId = process.env.MINIO_ROOT_USER;
const secretAccessKey = process.env.MINIO_ROOT_PASSWORD;

async function main() {
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("MINIO_ROOT_USER and MINIO_ROOT_PASSWORD are required");
  }

  const existing = (await pgStorageProfileRepository.listForAdmin()).find(
    (profile) => profile.name === name,
  );

  const actor = await pgDb
    .execute<{ id: string }>(
      sql`select id from "user" where role = 'admin' order by created_at asc limit 1`,
    )
    .then((result) => result.rows[0]?.id);
  if (!actor) throw new Error("No admin user found to attribute the profile");

  let profileId: string;
  if (existing) {
    profileId = existing.id;
    console.log(`Profile "${name}" already exists (${profileId})`);
  } else {
    const id = randomUUID();
    await pgStorageProfileRepository.create({
      id,
      name,
      driver: "minio",
      actorId: actor,
      s3: {
        endpoint,
        region,
        bucket,
        forcePathStyle: true,
        prefix: "uploads",
      },
      encryptedAccessKey: encryptSystemSettingValue(
        `fileStorage.profile.${id}.accessKey`,
        accessKeyId,
      ),
      encryptedSecretKey: encryptSystemSettingValue(
        `fileStorage.profile.${id}.secretKey`,
        secretAccessKey,
      ),
    });
    profileId = id;
    console.log(`Created profile "${name}" (${profileId})`);
  }

  const profile = await pgStorageProfileRepository.getById(profileId);
  if (!profile?.s3) throw new Error("Profile is missing S3 configuration");

  const storage = createProfileStorage(profile);
  const key = `iris-health/${randomUUID()}.txt`;
  try {
    await storage.upload(Buffer.from("iris-storage-ok"), {
      key,
      filename: "probe.txt",
      contentType: "text/plain",
    });
    const metadata = await storage.getMetadata(key);
    const bytes = await storage.download(key);
    if (!metadata || bytes.toString("utf8") !== "iris-storage-ok") {
      throw new Error("Storage verification failed");
    }
    console.log(`Probe OK against ${profile.s3.endpoint}/${bucket}`);
  } finally {
    await storage.delete(key).catch(() => undefined);
  }

  const active = await pgStorageProfileRepository.getActive();
  if (active?.id !== profileId) {
    await pgStorageProfileRepository.activate(profileId, actor);
    console.log(`Activated profile "${name}"`);
  } else {
    console.log(`Profile "${name}" is already active`);
  }

  await pgDb.execute(sql`select 1`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
