import { describe, expect, test, vi } from "vitest";
import { mergePreferredCapabilities } from "./capabilities/routing";

describe("native Harness north-star composition", () => {
  test("returns remote analysis to the parent before report completion", async () => {
    const snowflake = {
      type: "peerAgent" as const,
      agentId: "snowflake-agent",
      name: "Snowflake Revenue Analyst",
    };
    const report = {
      type: "defaultTool" as const,
      name: "generate_report",
      label: "Generate report",
    };
    const eligible = {
      "peerAgent:snowflake-agent": snowflake,
      "defaultTool:generate_report": report,
    };
    const requested = { "peerAgent:snowflake-agent": snowflake };
    const routed = mergePreferredCapabilities(eligible, requested, [
      { ...snowflake, routingMode: "prefer" },
    ]);
    expect(Object.keys(routed)).toEqual([
      "peerAgent:snowflake-agent",
      "defaultTool:generate_report",
    ]);

    const delegateAgent = vi.fn(async () => ({
      status: "succeeded",
      result: { revenue: 12_500_000, drivers: ["enterprise expansion"] },
    }));
    const generateReport = vi.fn(async (analysis) => ({
      artifact: {
        artifactId: "0f98f5c9-45f1-4a5f-88e4-56724ab11701",
        storageKey: "reports/q2-revenue-report.md",
        filename: "q2-revenue-report.md",
        mediaType: "text/markdown",
        size: 100,
        sha256: "a".repeat(64),
      },
      analysis,
    }));
    const delegated = await delegateAgent();
    const generated = await generateReport(delegated.result);

    expect(delegateAgent).toHaveBeenCalledBefore(generateReport);
    expect(generated.analysis).toBe(delegated.result);
    expect(generated.artifact).toMatchObject({ mediaType: "text/markdown" });
  });
});
