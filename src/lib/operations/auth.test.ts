import { describe, expect, it } from "vitest";
import { hasValidMetricsBearer } from "./auth";

describe("metrics bearer authentication", () => {
  it("accepts only an exact bearer token", () => {
    expect(hasValidMetricsBearer("Bearer secret", "secret")).toBe(true);
    expect(hasValidMetricsBearer("Bearer wrong", "secret")).toBe(false);
    expect(hasValidMetricsBearer("Basic secret", "secret")).toBe(false);
    expect(hasValidMetricsBearer(null, "secret")).toBe(false);
  });
});
