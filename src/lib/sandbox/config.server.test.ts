import { describe, expect, it, vi } from "vitest";
import { sandboxServerConfig } from "./config.server";

vi.mock("server-only", () => ({}));

describe("sandbox server configuration", () => {
  it("is disabled without runner credentials", () => {
    expect(sandboxServerConfig({} as NodeJS.ProcessEnv).enabled).toBe(false);
  });

  it("fails closed when enabled without URL or strong token", () => {
    expect(() =>
      sandboxServerConfig({
        IRIS_SANDBOX_ENABLED: "1",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow();
    expect(() =>
      sandboxServerConfig({
        IRIS_SANDBOX_ENABLED: "1",
        IRIS_RUNNER_URL: "http://sandbox-runner:8787",
        IRIS_RUNNER_TOKEN: "short",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it("accepts an explicit authenticated runner", () => {
    expect(
      sandboxServerConfig({
        IRIS_SANDBOX_ENABLED: "1",
        IRIS_RUNNER_URL: "http://sandbox-runner:8787",
        IRIS_RUNNER_TOKEN: "x".repeat(32),
      } as unknown as NodeJS.ProcessEnv),
    ).toMatchObject({ enabled: true, provider: "iris-runner" });
  });
});
