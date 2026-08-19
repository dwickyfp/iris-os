import { describe, expect, it } from "vitest";
import { classifyAbortedExecution } from "./execution-outcome";

describe("delegation abort classification", () => {
  it("distinguishes deadlines from cancellation regardless of adapter output", () => {
    const adapterResult = {
      status: "failed" as const,
      message: "AbortError",
    };
    expect(classifyAbortedExecution(adapterResult, "timeout")).toEqual({
      status: "timed_out",
      message: "Run deadline exceeded",
    });
    expect(classifyAbortedExecution(adapterResult, "cancelled")).toEqual({
      status: "cancelled",
      message: "Run was cancelled",
    });
    expect(classifyAbortedExecution(adapterResult, undefined)).toBe(
      adapterResult,
    );
    expect(classifyAbortedExecution(adapterResult, "lease_lost")).toBe(
      adapterResult,
    );
  });
});
