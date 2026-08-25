import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  decryptSystemSettingValue,
  encryptSystemSettingValue,
} from "./encrypted-value";

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
  env?: SecretEnv,
) {
  if (!env) return encryptSystemSettingValue("remote-agent.credential", value);
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

function parseLegacyEnvelope(value: string) {
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
  return { version: version as "v1" | "v2", iv, tag, payload };
}

export function decryptRemoteAgentSecret(value: string, env: SecretEnv): string;
export function decryptRemoteAgentSecret(value: string): Promise<string>;
export function decryptRemoteAgentSecret(value: string, env?: SecretEnv) {
  if (value.startsWith("ss1."))
    return decryptSystemSettingValue("remote-agent.credential", value);
  const { version } = parseLegacyEnvelope(value);
  if (env) return decryptLegacyWithEnv(value, version, env);
  return import("lib/system-settings/server")
    .then(async ({ systemSettingsService }) => {
      const [versioned, fallback] =
        version === "v1"
          ? ([
              "legacy.remoteAgentEncryptionKeyV1",
              "legacy.remoteAgentEncryptionKey",
            ] as const)
          : ([
              "legacy.remoteAgentEncryptionKeyV2",
              "legacy.remoteAgentEncryptionKey",
            ] as const);
      return (
        (await systemSettingsService.getSecret(versioned)) ??
        (await systemSettingsService.getSecret(fallback))
      );
    })
    .then((legacy) => {
      if (!legacy)
        throw new Error("Legacy remote-agent credential must be replaced");
      return decryptRemoteAgentSecret(
        value,
        version === "v2"
          ? { REMOTE_AGENT_ENCRYPTION_KEY_V2: legacy }
          : { REMOTE_AGENT_ENCRYPTION_KEY_V1: legacy },
      );
    });
}

function decryptLegacyWithEnv(
  value: string,
  version: "v1" | "v2",
  env: SecretEnv,
) {
  const { iv, tag, payload } = parseLegacyEnvelope(value);
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
