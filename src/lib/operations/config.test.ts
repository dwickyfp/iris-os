import { describe, expect, it } from "vitest";
import { parseOperationsConfig, validateOperationsConfig } from "./config";

const validEnv = {
  NODE_ENV: "test",
  POSTGRES_URL: "postgres://user:password@localhost:5432/iris",
};

describe("operations config", () => {
  it("parses bounded defaults with Zod", () => {
    const config = parseOperationsConfig(validEnv);
    expect(config).toMatchObject({
      IRIS_WORKER_REQUIRED: false,
      IRIS_WORKER_STALE_AFTER_MS: 45_000,
      IRIS_WORKER_HEARTBEAT_INTERVAL_MS: 10_000,
      IRIS_WORKER_MAX_CONSECUTIVE_HEARTBEAT_FAILURES: 3,
      OPERATIONS_READY_TIMEOUT_MS: 3_000,
    });
  });

  it("requires a metrics token in production", () => {
    const result = validateOperationsConfig({
      ...validEnv,
      NODE_ENV: "production",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a heartbeat interval too close to the stale threshold", () => {
    const result = validateOperationsConfig({
      ...validEnv,
      IRIS_WORKER_HEARTBEAT_INTERVAL_MS: "30000",
      IRIS_WORKER_STALE_AFTER_MS: "45000",
    });
    expect(result.success).toBe(false);
  });

  it.each([
    "IRIS_LEARNING_V2",
    "IRIS_AUTOMATION_V2",
    "IRIS_DELEGATION_V2",
    "IRIS_REMOTE_AGENTS_A2A",
  ])("requires the worker when %s is enabled", (flag) => {
    const config = parseOperationsConfig({
      ...validEnv,
      IRIS_WORKER_REQUIRED: "false",
      [flag]: "true",
    });

    expect(config.IRIS_WORKER_REQUIRED).toBe(true);
  });

  it("rejects an unbounded heartbeat failure threshold", () => {
    const result = validateOperationsConfig({
      ...validEnv,
      IRIS_WORKER_MAX_CONSECUTIVE_HEARTBEAT_FAILURES: "21",
    });

    expect(result.success).toBe(false);
  });
});
