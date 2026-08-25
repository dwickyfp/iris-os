import { describe, expect, test } from "vitest";
import {
  StrategyGuard,
  type StrategyGuardAttempt,
  fingerprintStrategyAttempt,
  stableHash,
  stableNormalize,
} from "./strategy-guard";

const base: StrategyGuardAttempt = {
  capabilityId: "capability:search",
  args: { query: "iris", filters: { year: 2026, exact: true } },
  result: { items: [] },
  evidence: ["source:a"],
  progress: ["searched"],
  requirements: ["requirement:research"],
};

describe("StrategyGuard fingerprints", () => {
  test("normalizes object keys and signals deterministically", () => {
    const reordered: StrategyGuardAttempt = {
      ...base,
      args: {
        filters: { exact: true, year: 2026 },
        query: "iris",
      },
      evidence: ["source:a", "source:a"],
    };

    expect(fingerprintStrategyAttempt(reordered)).toEqual(
      fingerprintStrategyAttempt(base),
    );
    expect(stableHash({ b: 2, a: 1 })).toBe(stableHash({ a: 1, b: 2 }));
    expect(stableNormalize([-0, Number.NaN, undefined, BigInt("2")])).toBe(
      '[{"$number":"-0"},{"$number":"NaN"},{"$undefined":""},{"$bigint":"2"}]',
    );
  });

  test("includes capability, normalized arguments, and result separately", () => {
    const fingerprint = fingerprintStrategyAttempt(base);
    const differentCapability = fingerprintStrategyAttempt({
      ...base,
      capabilityId: "capability:browse",
    });
    const differentResult = fingerprintStrategyAttempt({
      ...base,
      result: { items: ["new"] },
    });

    expect(differentCapability.action).not.toBe(fingerprint.action);
    expect(differentResult.action).toBe(fingerprint.action);
    expect(differentResult.result).not.toBe(fingerprint.result);
  });
});

describe("StrategyGuard escalation", () => {
  const guard = new StrategyGuard();

  test("conservatively escalates levels 1 through 4 for exact repeats", () => {
    const attempts = [base, base, base, base, base];
    const decisions = attempts
      .slice(1)
      .map((attempt, index) =>
        guard.evaluate({ attempt, history: attempts.slice(0, index + 1) }),
      );

    expect(decisions.map(({ level }) => level)).toEqual([1, 2, 3, 4]);
    expect(decisions.map(({ action }) => action)).toEqual([
      "correct",
      "correct",
      "correct",
      "stop",
    ]);
    expect(decisions[0].corrective?.code).toBe("change_arguments_or_strategy");
    expect(decisions[1].corrective?.code).toBe("change_capability");
    expect(decisions[3].corrective?.code).toBe("stop_repeating");
  });

  test.each([
    ["new evidence", { evidence: ["source:a", "source:b"] }, "new_evidence"],
    ["new progress", { progress: ["searched", "parsed"] }, "new_progress"],
    [
      "new requirement",
      { requirements: ["requirement:research", "requirement:write"] },
      "new_requirement",
    ],
  ] as const)(
    "allows an exact action/result with %s",
    (_name, update, reason) => {
      const decision = guard.evaluate({
        attempt: { ...base, ...update },
        history: [base],
      });

      expect(decision).toMatchObject({
        action: "allow",
        level: 1,
        reason,
        duplicateCount: 0,
        corrective: null,
      });
    },
  );

  test("allows a different capability even with identical args and result", () => {
    const decision = guard.evaluate({
      attempt: { ...base, capabilityId: "capability:browse" },
      history: [base, base, base, base],
    });

    expect(decision).toMatchObject({
      action: "allow",
      level: 1,
      reason: "different_capability",
    });
  });

  test("user steering resets escalation", () => {
    const decision = guard.evaluate({
      attempt: base,
      history: [base, base, base, base],
      userSteer: true,
    });

    expect(decision).toMatchObject({
      action: "allow",
      level: 1,
      reason: "user_steer",
      duplicateCount: 0,
      corrective: null,
    });
  });

  test("returns structured duplicate and corrective context", () => {
    const decision = guard.evaluate({ attempt: base, history: [base] });

    expect(decision).toMatchObject({
      reason: "exact_duplicate",
      signals: {
        exactActionDuplicate: true,
        exactResultDuplicate: true,
        newEvidence: [],
        newProgress: [],
        newRequirements: [],
      },
      corrective: {
        code: "change_arguments_or_strategy",
      },
    });
    expect(decision.corrective?.repeatedAction).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.corrective?.repeatedResult).toMatch(/^[a-f0-9]{64}$/);
  });
});
