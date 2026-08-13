import { describe, expect, it } from "vitest";
import {
  buildSemanticChecks,
  compareProgressiveAndEagerTokens,
  createBenchmarkSkills,
  estimateTokens,
} from "./benchmark-skills-utils";

describe("Skills benchmark utilities", () => {
  it("creates deterministic fixtures with exact ASCII body sizes", () => {
    const first = createBenchmarkSkills(2, 1024);
    const second = createBenchmarkSkills(2, 1024);

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(new TextEncoder().encode(first[0].body)).toHaveLength(1024);
  });

  it("uses a deterministic UTF-8 byte token estimate", () => {
    expect(estimateTokens("1234")).toBe(1);
    expect(estimateTokens("12345")).toBe(2);
    expect(estimateTokens("😀")).toBe(1);
  });

  it("shows increasing progressive reduction as skill count grows", () => {
    const comparisons = [1, 5, 10, 20].map((count) =>
      compareProgressiveAndEagerTokens({
        skills: createBenchmarkSkills(count, 10 * 1024),
        manifestPrompt: "manifest metadata",
      }),
    );

    expect(comparisons[0].reductionPercent).toBeLessThan(
      comparisons[1].reductionPercent,
    );
    expect(comparisons[1].reductionPercent).toBeLessThan(
      comparisons[2].reductionPercent,
    );
    expect(comparisons[2].reductionPercent).toBeLessThan(
      comparisons[3].reductionPercent,
    );
  });

  it("fails semantic checks when full content leaks", () => {
    const comparisons = [5, 10, 20].map((count) => ({
      skillCount: count,
      bodyBytes: 1024,
      progressiveTokens: 1,
      eagerTokens: 100,
      reductionPercent: 99,
    }));
    const checks = buildSemanticChecks({
      manifestPrompt: "x".repeat(64),
      listPayload: "metadata",
      cachedViewPayload: "cached",
      tokenComparisons: comparisons,
    });

    expect(
      checks.find((check) => check.name.includes("manifest"))?.passed,
    ).toBe(false);
  });
});
