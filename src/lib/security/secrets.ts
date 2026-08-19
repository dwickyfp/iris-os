import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v2";

type SecretEnv = Record<string, string | undefined>;

function encryptionKey(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required`);
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error(`${name} must be a base64-encoded 32-byte key`);
  }
  return key;
}

export function encryptRemoteAgentSecret(
  value: string,
  env: SecretEnv = process.env,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    ALGORITHM,
    encryptionKey(
      env.REMOTE_AGENT_ENCRYPTION_KEY_V2 ?? env.REMOTE_AGENT_ENCRYPTION_KEY,
      env.REMOTE_AGENT_ENCRYPTION_KEY_V2
        ? "REMOTE_AGENT_ENCRYPTION_KEY_V2"
        : "REMOTE_AGENT_ENCRYPTION_KEY",
    ),
    iv,
  );
  const payload = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    payload.toString("base64"),
  ].join(".");
}

export function decryptRemoteAgentSecret(
  value: string,
  env: SecretEnv = process.env,
) {
  const [version, iv, tag, payload, extra] = value.split(".");
  if (
    !(["v1", VERSION] as string[]).includes(version) ||
    !iv ||
    !tag ||
    !payload ||
    extra
  ) {
    throw new Error("Invalid encrypted remote agent credential");
  }
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      encryptionKey(
        version === "v2"
          ? (env.REMOTE_AGENT_ENCRYPTION_KEY_V2 ??
              env.REMOTE_AGENT_ENCRYPTION_KEY)
          : (env.REMOTE_AGENT_ENCRYPTION_KEY_V1 ??
              env.REMOTE_AGENT_ENCRYPTION_KEY),
        version === "v2" && env.REMOTE_AGENT_ENCRYPTION_KEY_V2
          ? "REMOTE_AGENT_ENCRYPTION_KEY_V2"
          : version === "v1" && env.REMOTE_AGENT_ENCRYPTION_KEY_V1
            ? "REMOTE_AGENT_ENCRYPTION_KEY_V1"
            : "REMOTE_AGENT_ENCRYPTION_KEY",
      ),
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(payload, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Invalid encrypted remote agent credential");
  }
}
