import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { decryptRemoteAgentSecret, encryptRemoteAgentSecret } = await import(
  "./secrets"
);

describe("remote agent secrets", () => {
  it("round-trips authenticated ciphertext without retaining plaintext", () => {
    const env: Record<string, string> = {
      REMOTE_AGENT_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    };
    const encrypted = encryptRemoteAgentSecret("production-secret", env);
    expect(encrypted).toMatch(/^v2\./);
    expect(encrypted).not.toContain("production-secret");
    expect(decryptRemoteAgentSecret(encrypted, env)).toBe("production-secret");
    const parts = encrypted.split(".");
    parts[2] = randomBytes(16).toString("base64");
    expect(() => decryptRemoteAgentSecret(parts.join("."), env)).toThrow(
      "Invalid encrypted",
    );
  });

  it("writes v2 with the active key and reads legacy v1 during rotation", () => {
    const oldKey = randomBytes(32).toString("base64");
    const newKey = randomBytes(32).toString("base64");
    const legacy = encryptRemoteAgentSecret("legacy", {
      REMOTE_AGENT_ENCRYPTION_KEY: oldKey,
    }).replace(/^v2\./, "v1.");
    const env = {
      REMOTE_AGENT_ENCRYPTION_KEY_V1: oldKey,
      REMOTE_AGENT_ENCRYPTION_KEY_V2: newKey,
    };
    expect(decryptRemoteAgentSecret(legacy, env)).toBe("legacy");
    const current = encryptRemoteAgentSecret("current", env);
    expect(current).toMatch(/^v2\./);
    expect(decryptRemoteAgentSecret(current, env)).toBe("current");
  });

  it("requires a dedicated 32-byte key", () => {
    expect(() => encryptRemoteAgentSecret("secret", {})).toThrow(
      "REMOTE_AGENT_ENCRYPTION_KEY is required",
    );
    expect(() =>
      encryptRemoteAgentSecret("secret", {
        REMOTE_AGENT_ENCRYPTION_KEY: "not-a-key",
      }),
    ).toThrow("32-byte key");
  });
});
