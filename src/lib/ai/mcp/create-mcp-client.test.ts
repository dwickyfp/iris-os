import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  listTools: vi.fn().mockResolvedValue({ tools: [] }),
  stdioOptions: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mocks.connect;
    listTools = mocks.listTools;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(options: Record<string, unknown>) {
      mocks.stdioOptions = options;
    }
  },
}));

vi.mock("lib/const", () => ({
  BASE_URL: "http://localhost:3000",
  IS_MCP_SERVER_REMOTE_ONLY: false,
  IS_VERCEL_ENV: false,
}));

vi.mock("logger", () => ({
  default: {
    withDefaults: () => ({
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

vi.mock("./pg-oauth-provider", () => ({
  PgOAuthClientProvider: class {},
}));

import { createMCPClient } from "./create-mcp-client";

describe("MCPClient stdio environment", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stdioOptions = undefined;
    process.env = {
      NODE_ENV: "test",
      PATH: "/safe/bin",
      HOME: "/safe/home",
      TMPDIR: "/safe/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      SSL_CERT_FILE: "/safe/certs.pem",
      NODE_EXTRA_CA_CERTS: "/safe/extra-certs.pem",
      BOOTSTRAP_SECRET: "bootstrap-secret",
      DATABASE_URL: "postgres://secret",
      BETTER_AUTH_SECRET: "auth-secret",
      OPENAI_API_KEY: "provider-secret",
      S3_SECRET_ACCESS_KEY: "storage-secret",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("inherits only safe runtime variables", async () => {
    const client = createMCPClient("server-id", "server", {
      command: "mcp-server",
    });

    await client.connect();

    expect(mocks.stdioOptions?.env).toEqual({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      TMPDIR: "/safe/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      SSL_CERT_FILE: "/safe/certs.pem",
      NODE_EXTRA_CA_CERTS: "/safe/extra-certs.pem",
    });
  });

  it("adds explicit config env and lets it override inherited values", async () => {
    const client = createMCPClient("server-id", "server", {
      command: "mcp-server",
      env: {
        PATH: "/configured/bin",
        DATABASE_URL: "postgres://explicit",
        CUSTOM_TOKEN: "explicit-token",
      },
    });

    await client.connect();

    expect(mocks.stdioOptions?.env).toEqual(
      expect.objectContaining({
        PATH: "/configured/bin",
        DATABASE_URL: "postgres://explicit",
        CUSTOM_TOKEN: "explicit-token",
      }),
    );
    expect(mocks.stdioOptions?.env).not.toHaveProperty("BETTER_AUTH_SECRET");
    expect(mocks.stdioOptions?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(mocks.stdioOptions?.env).not.toHaveProperty("S3_SECRET_ACCESS_KEY");
    expect(mocks.stdioOptions?.env).not.toHaveProperty("BOOTSTRAP_SECRET");
  });
});
