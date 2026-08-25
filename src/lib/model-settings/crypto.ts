import "server-only";

import { createDecipheriv } from "node:crypto";
import {
  decryptSystemSettingValue,
  encryptSystemSettingValue,
} from "lib/security/encrypted-value";

const SETTING_KEY = "model-provider.apiKey";

export function encryptSecret(value: string) {
  return encryptSystemSettingValue(SETTING_KEY, value);
}

async function decryptLegacy(value: string) {
  const { systemSettingsService } = await import("lib/system-settings/server");
  const encoded = await systemSettingsService.getSecret(
    "legacy.modelSettingsEncryptionKey",
  );
  if (!encoded) throw new Error("Legacy model encryption key is not configured");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("Invalid legacy model encryption key");
  const [ivValue, tagValue, payload] = value.split(".");
  if (!ivValue || !tagValue || !payload)
    throw new Error("Invalid encrypted model credential");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivValue, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export async function decryptSecret(value: string) {
  return value.startsWith("ss1.")
    ? decryptSystemSettingValue(SETTING_KEY, value)
    : decryptLegacy(value);
}

export function maskSecret(value: string | null) {
  return value ? "••••" : null;
}
