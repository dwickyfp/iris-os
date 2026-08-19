import { describe, expect, it } from "vitest";
import {
  assertHarnessContainerName,
  createHarnessEnvironment,
  parseLoopbackPort,
  playwrightBrowsersPath,
} from "./harness-safety";

describe("Harness environment safety", () => {
  it("only inherits safe process basics from a poisoned environment", () => {
    const environment = createHarnessEnvironment(
      {
        PATH: "/safe/bin",
        HOME: "/user/home-with-external-credentials",
        POSTGRES_URL: "postgres://production",
        TEST_POSTGRES_URL: "postgres://shared-test",
        OPENAI_API_KEY: "provider-secret",
        AWS_SECRET_ACCESS_KEY: "cloud-secret",
        BLOB_READ_WRITE_TOKEN: "storage-secret",
        MCP_CONFIG_PATH: "/shared/mcp.json",
        REDIS_URL: "redis://shared.example",
        HTTPS_PROXY: "https://proxy.example",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://telemetry.example",
        NEXT_PUBLIC_BASE_URL: "https://production.example",
      },
      {
        POSTGRES_URL: "postgres://127.0.0.1/harness",
        NEXT_PUBLIC_BASE_URL: "http://127.0.0.1:3001",
        HOME: "/isolated/harness-home",
        PLAYWRIGHT_BROWSERS_PATH: "/host/cache/ms-playwright",
      },
    );

    expect(environment).toMatchObject({
      PATH: "/safe/bin",
      HOME: "/isolated/harness-home",
      POSTGRES_URL: "postgres://127.0.0.1/harness",
      NEXT_PUBLIC_BASE_URL: "http://127.0.0.1:3001",
      PLAYWRIGHT_BROWSERS_PATH: "/host/cache/ms-playwright",
    });
    for (const variable of [
      "TEST_POSTGRES_URL",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "BLOB_READ_WRITE_TOKEN",
      "MCP_CONFIG_PATH",
      "REDIS_URL",
      "HTTPS_PROXY",
    ]) {
      expect(environment[variable]).toBe("");
    }
    expect(environment.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://127.0.0.1:1");
  });

  it("derives only the Playwright browser cache from the host home", () => {
    expect(playwrightBrowsersPath("/Users/example")).toBe(
      "/Users/example/Library/Caches/ms-playwright",
    );
    expect(() => playwrightBrowsersPath(undefined)).toThrow("absolute host home");
  });

  it("refuses variables outside the runner-generated allowlist", () => {
    expect(() =>
      createHarnessEnvironment({}, { OPENAI_API_KEY: "secret" }),
    ).toThrow("unexpected Harness variable");
  });

  it("only accepts generated Harness container names", () => {
    expect(() =>
      assertHarnessContainerName("iris-harness-pg-a1b2c3"),
    ).not.toThrow();
    expect(() => assertHarnessContainerName("iris-os-pg")).toThrow("Refusing");
    expect(() =>
      assertHarnessContainerName("iris-harness-pg-../../shared"),
    ).toThrow("Refusing");
  });

  it("only accepts loopback Docker port bindings", () => {
    expect(parseLoopbackPort("127.0.0.1:49172\n")).toBe(49172);
    expect(() => parseLoopbackPort("0.0.0.0:49172")).toThrow("unsafely");
    expect(() => parseLoopbackPort("[::]:49172")).toThrow("unsafely");
  });
});
