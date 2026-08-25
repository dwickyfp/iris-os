import "load-env";

import { randomUUID } from "node:crypto";
import { SYSTEM_SETTING_DEFINITIONS } from "lib/system-settings/definitions";
import { systemSettingsService } from "lib/system-settings/server";
import type { SystemSettingKey, SystemSettingScalar } from "app-types/system-settings";
import { pgStorageProfileRepository } from "lib/db/pg/repositories/storage-profile-repository.pg";
import { encryptSystemSettingValue } from "lib/security/encrypted-value";

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";
const inverted = new Set<SystemSettingKey>([
  "auth.emailSignInEnabled",
  "auth.emailSignUpEnabled",
  "auth.oauthSignUpEnabled",
  "mcp.allowUserServers",
]);

function parseLegacy(key: SystemSettingKey, raw: string): SystemSettingScalar {
  const definition = SYSTEM_SETTING_DEFINITIONS[key];
  if (typeof definition.default === "boolean") {
    const enabled = ["1", "true", "yes", "on"].includes(raw.toLowerCase());
    return inverted.has(key) ? !enabled : enabled;
  }
  if (typeof definition.default === "number") return Number(raw);
  return raw;
}

for (const key of Object.keys(SYSTEM_SETTING_DEFINITIONS) as SystemSettingKey[]) {
  const definition = SYSTEM_SETTING_DEFINITIONS[key];
  const raw = process.env[definition.env];
  if (!raw) continue;
  const existing = (await systemSettingsService.list()).find(
    (setting) => setting.key === key,
  );
  if ((existing?.revision ?? 0) > 0) {
    console.info(`${key}: already configured`);
    continue;
  }
  await systemSettingsService.mutate(
    { operation: "set", key, value: parseLegacy(key, raw) },
    SYSTEM_ACTOR_ID,
    0,
  );
  console.info(`${key}: imported`);
}

if (process.env.FILE_STORAGE_TYPE === "s3") {
  const bucket = process.env.FILE_STORAGE_S3_BUCKET;
  const region = process.env.FILE_STORAGE_S3_REGION ?? process.env.AWS_REGION;
  const accessKey = process.env.AWS_ACCESS_KEY_ID;
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (bucket && region && accessKey && secretKey) {
    const id = randomUUID();
    const driver = process.env.FILE_STORAGE_S3_ENDPOINT ? "minio" : "s3";
    await pgStorageProfileRepository.create({
      id,
      name: "Imported object storage",
      driver,
      actorId: SYSTEM_ACTOR_ID,
      s3: {
        endpoint: process.env.FILE_STORAGE_S3_ENDPOINT,
        region,
        bucket,
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
        forcePathStyle:
          driver === "minio" ||
          /^(1|true)$/i.test(process.env.FILE_STORAGE_S3_FORCE_PATH_STYLE ?? ""),
        publicBaseUrl: process.env.FILE_STORAGE_S3_PUBLIC_BASE_URL,
        prefix: process.env.FILE_STORAGE_PREFIX ?? "uploads",
      },
      encryptedAccessKey: encryptSystemSettingValue(
        `fileStorage.profile.${id}.accessKey`,
        accessKey,
      ),
      encryptedSecretKey: encryptSystemSettingValue(
        `fileStorage.profile.${id}.secretKey`,
        secretKey,
      ),
    });
    console.info("object storage: imported; test and activate in Admin > Settings");
  }
}
