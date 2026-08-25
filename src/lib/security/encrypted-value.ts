import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = "ss1";
const ACTIVE_KEY_ID = "root-v1";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HKDF_SALT = Buffer.from("iris-os:system-settings:hkdf-salt:v1");
const HKDF_INFO = Buffer.from("iris-os:system-settings:encryption:v1");

type EncryptionEnv = Record<string, string | undefined>;

function decodeRootKey(value: string | undefined): Buffer {
  if (!value) throw new Error("IRIS_ROOT_ENCRYPTION_KEY is required");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error(
      "IRIS_ROOT_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error(
      "IRIS_ROOT_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  }
  return key;
}

function rootKey(env: EncryptionEnv): string | undefined {
  return env.IRIS_ROOT_ENCRYPTION_KEY;
}

function decodeEnvelopePart(value: string, expectedBytes?: number): Buffer {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error("Invalid encrypted system setting");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value ||
    (expectedBytes !== undefined && decoded.length !== expectedBytes)
  ) {
    throw new Error("Invalid encrypted system setting");
  }
  return decoded;
}

export function deriveSystemSettingsKey(rootEncryptionKey: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      decodeRootKey(rootEncryptionKey),
      HKDF_SALT,
      HKDF_INFO,
      32,
    ),
  );
}

export function encryptSystemSettingValue(
  settingKey: string,
  plaintext: string,
  env: EncryptionEnv = process.env,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(
    ALGORITHM,
    deriveSystemSettingsKey(rootKey(env) ?? ""),
    iv,
  );
  cipher.setAAD(Buffer.from(settingKey, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    ENVELOPE_VERSION,
    ACTIVE_KEY_ID,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

export function decryptSystemSettingValue(
  settingKey: string,
  envelope: string,
  env: EncryptionEnv = process.env,
): string {
  const parts = envelope.split(".");
  if (
    parts.length !== 5 ||
    parts[0] !== ENVELOPE_VERSION ||
    parts[1] !== ACTIVE_KEY_ID
  ) {
    throw new Error("Invalid encrypted system setting");
  }

  const iv = decodeEnvelopePart(parts[2], IV_BYTES);
  const tag = decodeEnvelopePart(parts[3], AUTH_TAG_BYTES);
  const ciphertext = decodeEnvelopePart(parts[4]);
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      deriveSystemSettingsKey(rootKey(env) ?? ""),
      iv,
    );
    decipher.setAAD(Buffer.from(settingKey, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("IRIS_ROOT_ENCRYPTION_KEY")
    ) {
      throw error;
    }
    throw new Error("Invalid encrypted system setting");
  }
}
