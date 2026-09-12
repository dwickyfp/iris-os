import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

const TEST_ROOT_KEY = "VuPHmLi3nrt40ZCn4JMyAv1aZuLp4bxsYbWYZEjoq0c=";

describe("MCP credential encryption at rest", () => {
  let crypto: typeof import("./mcp-credential-crypto");

  beforeEach(async () => {
    process.env.IRIS_ROOT_ENCRYPTION_KEY = TEST_ROOT_KEY;
    vi.resetModules();
    crypto = await import("./mcp-credential-crypto");
  });

  test("server config round-trips through an encrypted envelope", () => {
    const config = {
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "Bearer super-secret-token" },
    };
    const stored = crypto.encryptMcpServerConfig(config);

    expect(stored).not.toContain("super-secret-token");
    expect(stored.startsWith("ss1.")).toBe(true);
    expect(crypto.decryptMcpServerConfig(stored)).toEqual(config);
  });

  test("OAuth tokens, client info, and code verifier round-trip encrypted", () => {
    const data = {
      clientInfo: { client_id: "abc", client_secret: "shh" },
      tokens: { access_token: "at", refresh_token: "rt" },
      codeVerifier: "pkce-verifier-value",
    };
    const stored = crypto.encryptMcpOAuthSecrets(data);

    expect(stored.tokens).not.toContain("at");
    expect(JSON.stringify(stored)).not.toContain("shh");
    expect(stored.codeVerifier).not.toContain("pkce-verifier-value");

    const decrypted = crypto.decryptMcpOAuthSecrets(stored);
    expect(decrypted.clientInfo).toEqual(data.clientInfo);
    expect(decrypted.tokens).toEqual(data.tokens);
    expect(decrypted.codeVerifier).toBe("pkce-verifier-value");
  });

  test("empty credential fields are not encrypted", () => {
    const stored = crypto.encryptMcpOAuthSecrets({ codeVerifier: undefined });
    expect(stored).toEqual({});
  });

  test("legacy plaintext rows remain readable", () => {
    const legacyConfig = { command: "python", args: ["mcp.py"] };
    expect(crypto.decryptMcpServerConfig(legacyConfig)).toEqual(legacyConfig);
    expect(crypto.decryptMcpOAuthSecrets({ codeVerifier: "plain" })).toEqual({
      codeVerifier: "plain",
    });
    expect(
      crypto.decryptMcpOAuthSecrets({ tokens: { access_token: "legacy" } }),
    ).toEqual({ tokens: { access_token: "legacy" } });
  });

  test("tampered envelopes fail closed", () => {
    const stored = crypto.encryptMcpServerConfig({ url: "https://x.test" });
    const tampered = `${stored.slice(0, -2)}xx`;
    expect(() => crypto.decryptMcpServerConfig(tampered)).toThrow();
  });
});
