import { hkdfSync } from "node:crypto";

const HKDF_SALT = Buffer.from("iris-os:bootstrap-secrets:hkdf-salt:v1");

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

export function deriveBootstrapSecret(
  rootEncryptionKey: string | undefined,
  purpose: string,
): string {
  if (!purpose) throw new Error("Bootstrap secret purpose is required");
  return Buffer.from(
    hkdfSync(
      "sha256",
      decodeRootKey(rootEncryptionKey),
      HKDF_SALT,
      Buffer.from(purpose),
      32,
    ),
  ).toString("base64url");
}
