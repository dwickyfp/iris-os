import { describe, expect, it } from "vitest";
import {
  assertDisposableBenchmarkContainerName,
  assertDisposableBenchmarkProof,
  benchmarkIterations,
  createDisposableBenchmarkEnvironment,
  createDisposablePostgresUrl,
  parseDisposableLoopbackPort,
} from "./a2a-disposable-benchmark-safety";

describe("disposable A2A benchmark safety", () => {
  it("only inherits safe process basics from a poisoned environment", () => {
    const environment = createDisposableBenchmarkEnvironment(
      {
        POSTGRES_URL: "postgresql://app.example/iris",
        TEST_POSTGRES_URL: "postgresql://shared.example/iris_test",
        DATABASE_URL: "postgresql://legacy.example/iris",
        A2A_BENCHMARK_POSTGRES_URL: "postgresql://attacker.example/bench",
        A2A_BENCHMARK_ALLOW_APP_DATABASE: "I_UNDERSTAND_DATA_IS_MUTATED",
        PATH: "/safe/bin",
        OPENAI_API_KEY: "provider-secret",
        AWS_SECRET_ACCESS_KEY: "cloud-secret",
        BLOB_READ_WRITE_TOKEN: "storage-secret",
        MCP_CONFIG_PATH: "/shared/mcp.json",
        REDIS_URL: "redis://shared.example",
        HTTP_PROXY: "http://proxy.example",
        OTEL_EXPORTER_OTLP_HEADERS: "telemetry-secret",
        NEXT_PUBLIC_BASE_URL: "https://production.example",
      },
      { POSTGRES_URL: "postgresql://iris@127.0.0.1/benchmark" },
    );

    expect(environment).toMatchObject({
      POSTGRES_URL: "postgresql://iris@127.0.0.1/benchmark",
      PATH: "/safe/bin",
    });
    expect(environment.TEST_POSTGRES_URL).toBeUndefined();
    expect(environment.DATABASE_URL).toBeUndefined();
    expect(environment.A2A_BENCHMARK_POSTGRES_URL).toBeUndefined();
    expect(environment.A2A_BENCHMARK_ALLOW_APP_DATABASE).toBeUndefined();
    for (const variable of [
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "BLOB_READ_WRITE_TOKEN",
      "MCP_CONFIG_PATH",
      "REDIS_URL",
      "HTTP_PROXY",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "NEXT_PUBLIC_BASE_URL",
    ]) {
      expect(environment[variable]).toBeUndefined();
    }
  });

  it("refuses variables outside the wrapper-generated allowlist", () => {
    expect(() =>
      createDisposableBenchmarkEnvironment({}, { REDIS_URL: "redis://shared" }),
    ).toThrow("unexpected benchmark variable");
  });

  it("only manages generated container names", () => {
    expect(() =>
      assertDisposableBenchmarkContainerName(
        "iris-a2a-benchmark-pg-a1b2c3d4e5f6",
      ),
    ).not.toThrow();
    expect(() => assertDisposableBenchmarkContainerName("iris-os-pg")).toThrow(
      "Refusing",
    );
    expect(() =>
      assertDisposableBenchmarkContainerName(
        "iris-a2a-benchmark-pg-../../shared",
      ),
    ).toThrow("Refusing");
  });

  it("only accepts Docker-assigned loopback bindings", () => {
    expect(parseDisposableLoopbackPort("127.0.0.1:49172\n")).toBe(49172);
    expect(() => parseDisposableLoopbackPort("0.0.0.0:49172")).toThrow(
      "unsafely",
    );
    expect(() => parseDisposableLoopbackPort("[::]:49172")).toThrow("unsafely");
  });

  it("bounds disposable benchmark iterations", () => {
    expect(benchmarkIterations(undefined)).toBe(10);
    expect(benchmarkIterations("25")).toBe(25);
    expect(() => benchmarkIterations("0")).toThrow("1 to 100");
    expect(() => benchmarkIterations("101")).toThrow("1 to 100");
    expect(() => benchmarkIterations("1.5")).toThrow("1 to 100");
  });

  it("builds URLs only for generated loopback databases", () => {
    const password = "a".repeat(48);
    const url = createDisposablePostgresUrl({
      database: "iris_a2a_benchmark_a1b2c3d4e5f6",
      password,
      port: 49172,
    });
    expect(url).toBe(
      `postgresql://iris:${password}@127.0.0.1:49172/iris_a2a_benchmark_a1b2c3d4e5f6`,
    );
    expect(() =>
      createDisposablePostgresUrl({
        database: "iris_production",
        password,
        port: 49172,
      }),
    ).toThrow("non-generated");
  });

  it("requires exact wrapper proof and rejects app databases by URL", () => {
    const proof = {
      connectionString:
        "postgresql://iris:secret@127.0.0.1:49172/iris_a2a_benchmark_a1b2c3d4e5f6",
      database: "iris_a2a_benchmark_a1b2c3d4e5f6",
      marker: "iris-a2a-disposable-a1b2c3d4e5f6",
      token: "a".repeat(64),
      nonce: "b".repeat(48),
    };
    expect(() => assertDisposableBenchmarkProof(proof)).not.toThrow();
    expect(() =>
      assertDisposableBenchmarkProof({
        ...proof,
        database: "iris_a2a_benchmark_000000000000",
      }),
    ).toThrow("does not match");
    expect(() =>
      assertDisposableBenchmarkProof({
        ...proof,
        applicationDatabaseUrls: [
          "postgres://app_user:different@127.0.0.1:49172/iris_a2a_benchmark_a1b2c3d4e5f6",
        ],
      }),
    ).toThrow("application database");
  });
});
