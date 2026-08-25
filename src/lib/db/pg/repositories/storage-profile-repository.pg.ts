import "server-only";

import { sql } from "drizzle-orm";
import type {
  FileStorageProfile,
  StorageProfileRepository,
} from "lib/file-storage/storage-profile";
import { decryptSystemSettingValue } from "lib/security/encrypted-value";
import { pgDb } from "../db.pg";

interface StorageProfileRow {
  id: string;
  name: string;
  driver: FileStorageProfile["driver"];
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  encryptedAccessKey: string | null;
  encryptedSecretKey: string | null;
  forcePathStyle: boolean | null;
  publicBaseUrl: string | null;
  prefix: string | null;
  version: number;
}

type QueryResult = { rows: Record<string, unknown>[] };

export interface StorageProfileQueryExecutor {
  execute(query: ReturnType<typeof sql>): Promise<QueryResult>;
  transaction?<T>(
    operation: (tx: StorageProfileQueryExecutor) => Promise<T>,
  ): Promise<T>;
}

export type StorageProfileCredentialDecryptor = (
  settingKey: string,
  encryptedValue: string,
) => Promise<string> | string;

function settingKey(profileId: string, credential: "accessKey" | "secretKey") {
  return `fileStorage.profile.${profileId}.${credential}`;
}

function asRow(value: Record<string, unknown>): StorageProfileRow {
  return value as unknown as StorageProfileRow;
}

async function mapProfile(
  value: Record<string, unknown> | undefined,
  decrypt: StorageProfileCredentialDecryptor,
): Promise<FileStorageProfile | null> {
  if (!value) return null;
  const row = asRow(value);
  if (row.driver === "vercel-blob") {
    return {
      id: row.id,
      name: row.name,
      driver: row.driver,
      version: row.version,
    };
  }
  if (!row.bucket || !row.region) {
    throw new Error(`Storage profile ${row.id} is missing S3 configuration`);
  }
  const [accessKeyId, secretAccessKey] = await Promise.all([
    row.encryptedAccessKey
      ? decrypt(settingKey(row.id, "accessKey"), row.encryptedAccessKey)
      : undefined,
    row.encryptedSecretKey
      ? decrypt(settingKey(row.id, "secretKey"), row.encryptedSecretKey)
      : undefined,
  ]);
  return {
    id: row.id,
    name: row.name,
    driver: row.driver,
    version: row.version,
    s3: {
      endpoint: row.endpoint ?? undefined,
      region: row.region,
      bucket: row.bucket,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: row.forcePathStyle ?? undefined,
      publicBaseUrl: row.publicBaseUrl ?? undefined,
      prefix: row.prefix ?? undefined,
    },
  };
}

const profileProjection = sql.raw(`
  p.id,
  p.name,
  p.driver,
  p.endpoint,
  p.region,
  p.bucket,
  p.encrypted_access_key AS "encryptedAccessKey",
  p.encrypted_secret_key AS "encryptedSecretKey",
  p.force_path_style AS "forcePathStyle",
  p.public_base_url AS "publicBaseUrl",
  p.prefix
  ,p.version
`);

export function createPgStorageProfileRepository(
  db: StorageProfileQueryExecutor,
  decrypt: StorageProfileCredentialDecryptor = decryptSystemSettingValue,
): StorageProfileRepository {
  return {
    async getActive() {
      const result = await db.execute(sql`
        SELECT ${profileProjection}
        FROM file_storage_setting s
        INNER JOIN file_storage_profile p ON p.id = s.active_profile_id
        LIMIT 1
      `);
      return mapProfile(result.rows[0], decrypt);
    },
    async getById(profileId) {
      const result = await db.execute(sql`
        SELECT ${profileProjection}
        FROM file_storage_profile p
        WHERE p.id = ${profileId}
        LIMIT 1
      `);
      return mapProfile(result.rows[0], decrypt);
    },
    async listForAdmin() {
      const result = await db.execute(sql`
        SELECT ${profileProjection},
               (p.encrypted_access_key IS NOT NULL) AS "hasCredentials",
               (s.active_profile_id = p.id) AS active
        FROM file_storage_profile p
        LEFT JOIN file_storage_setting s ON s.active_profile_id = p.id
        ORDER BY p.created_at DESC
      `);
      return result.rows.map((value) => {
        const row = asRow(value);
        return {
          id: row.id,
          name: row.name,
          driver: row.driver,
          version: row.version,
          hasCredentials: Boolean(value.hasCredentials),
          active: Boolean(value.active),
          ...(row.driver === "vercel-blob"
            ? {}
            : {
                s3: {
                  endpoint: row.endpoint ?? undefined,
                  region: row.region!,
                  bucket: row.bucket!,
                  forcePathStyle: row.forcePathStyle ?? undefined,
                  publicBaseUrl: row.publicBaseUrl ?? undefined,
                  prefix: row.prefix ?? undefined,
                },
              }),
        };
      });
    },
    async create(input) {
      await db.execute(sql`
        INSERT INTO file_storage_profile
          (id, name, driver, endpoint, region, bucket,
           encrypted_access_key, encrypted_secret_key, force_path_style,
           public_base_url, prefix, created_by)
        VALUES
          (${input.id}, ${input.name}, ${input.driver},
           ${input.s3?.endpoint ?? null}, ${input.s3?.region ?? null},
           ${input.s3?.bucket ?? null}, ${input.encryptedAccessKey ?? null},
           ${input.encryptedSecretKey ?? null},
           ${input.driver === "minio" ? true : (input.s3?.forcePathStyle ?? false)},
           ${input.s3?.publicBaseUrl ?? null}, ${input.s3?.prefix ?? "uploads"},
           ${input.actorId})
      `);
      return (await this.getById(input.id))!;
    },
    async activate(profileId, actorId, options) {
      const activate = async (executor: StorageProfileQueryExecutor) => {
        if (options?.adoptLegacyObjects) {
          await executor.execute(sql`
            UPDATE artifact
            SET storage_profile_id = ${profileId}
            WHERE storage_profile_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM file_storage_setting)
          `);
          await executor.execute(sql`
            UPDATE artifact_cleanup
            SET storage_profile_id = ${profileId}
            WHERE storage_profile_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM file_storage_setting)
          `);
        }
        await executor.execute(sql`
          INSERT INTO file_storage_setting
            (singleton, active_profile_id, version, updated_by)
          VALUES (true, ${profileId}, 1, ${actorId})
          ON CONFLICT (singleton) DO UPDATE SET
            active_profile_id = EXCLUDED.active_profile_id,
            version = file_storage_setting.version + 1,
            updated_by = EXCLUDED.updated_by,
            updated_at = CURRENT_TIMESTAMP
        `);
      };
      if (db.transaction) await db.transaction(activate);
      else await activate(db);
    },
  };
}

export const pgStorageProfileRepository = createPgStorageProfileRepository(
  pgDb as unknown as StorageProfileQueryExecutor,
);
