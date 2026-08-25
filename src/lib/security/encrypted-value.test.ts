import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  decryptSystemSettingValue,
  deriveSystemSettingsKey,
  encryptSystemSettingValue,
} = await import("./encrypted-value");

const root = randomBytes(32).toString("base64");
const env = { IRIS_ROOT_ENCRYPTION_KEY: root };

describe("encrypted system setting values", () => {
  it("derives a stable purpose-specific 256-bit key", () => {
    const first = deriveSystemSettingsKey(root);
    expect(first).toHaveLength(32);
    expect(first).toEqual(deriveSystemSettingsKey(root));
    expect(first).not.toEqual(Buffer.from(root, "base64"));
  });

  it("round-trips a versioned envelope without retaining plaintext", () => {
    const encrypted = encryptSystemSettingValue(
      "exa.apiKey",
      "production-secret",
      env,
    );
    expect(encrypted).toMatch(/^ss1\.root-v1\./);
    expect(encrypted).not.toContain("production-secret");
    expect(decryptSystemSettingValue("exa.apiKey", encrypted, env)).toBe(
      "production-secret",
    );
  });

  it("binds ciphertext to its setting key through authenticated data", () => {
    const encrypted = encryptSystemSettingValue(
      "oauth.github.clientSecret",
      "secret",
      env,
    );
    expect(() =>
      decryptSystemSettingValue("oauth.google.clientSecret", encrypted, env),
    ).toThrow("Invalid encrypted system setting");
  });

  it("rejects tampering and malformed envelopes", () => {
    const encrypted = encryptSystemSettingValue("redis.url", "secret", env);
    const parts = encrypted.split(".");
    parts[3] = randomBytes(16).toString("base64");
    expect(() =>
      decryptSystemSettingValue("redis.url", parts.join("."), env),
    ).toThrow("Invalid encrypted system setting");
    expect(() =>
      decryptSystemSettingValue("redis.url", "ss2.root-v1.bad", env),
    ).toThrow("Invalid encrypted system setting");
  });

  it("requires a canonical base64-encoded 32-byte root key", () => {
    expect(() => encryptSystemSettingValue("exa.apiKey", "secret", {})).toThrow(
      "IRIS_ROOT_ENCRYPTION_KEY is required",
    );
    expect(() =>
      encryptSystemSettingValue("exa.apiKey", "secret", {
        IRIS_ROOT_ENCRYPTION_KEY: "not-a-key",
      }),
    ).toThrow("base64-encoded 32-byte key");
  });
});
