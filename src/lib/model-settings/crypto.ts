import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function encryptionKey() {
  const value = process.env.MODEL_SETTINGS_ENCRYPTION_KEY;
  if (!value) {
    throw new Error("MODEL_SETTINGS_ENCRYPTION_KEY is required");
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error(
      "MODEL_SETTINGS_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  }
  return key;
}

export function encryptSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}

export function decryptSecret(value: string) {
  const [ivValue, tagValue, payload] = value.split(".");
  if (!ivValue || !tagValue || !payload)
    throw new Error("Invalid encrypted model credential");
  const decipher = createDecipheriv(
    ALGORITHM,
    encryptionKey(),
    Buffer.from(ivValue, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function maskSecret(value: string | null) {
  if (!value) return null;
  return "••••";
}
