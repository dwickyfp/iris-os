import { describe, expect, it } from "vitest";
import {
  type RunProjectionInput,
  type RunProjectionState,
  buildRunProjection,
} from "./projection";

function project(overrides: Partial<RunProjectionInput> = {}) {
  return buildRunProjection({
    run: { status: "queued", startedAt: null },
    ...overrides,
  });
}

describe("buildRunProjection", () => {
  const cases: Array<[Partial<RunProjectionInput>, RunProjectionState]> = [
    [{ run: { status: "queued", startedAt: null } }, "Understanding request"],
    [
      { run: { status: "running", startedAt: new Date() } },
      "Gathering information",
    ],
    [{ children: [{ status: "running" as const }] }, "Working with specialist"],
    [{ goalRound: 2, revision: 1 }, "Comparing results"],
    [{ artifactSummary: { total: 1 } }, "Preparing output"],
    [{ approvals: [{ status: "pending" as const }] }, "Waiting approval"],
    [
      { blockerSummary: { total: 1, requiringInformation: 1 } },
      "Need information",
    ],
    [{ run: { status: "succeeded" as const } }, "Completed"],
  ];

  it.each(cases)("derives %s as %s", (overrides, expected) => {
    expect(project(overrides).state).toBe(expected);
  });

  it("uses authoritative terminal and waiting statuses before advisory signals", () => {
    expect(
      project({
        run: { status: "failed" },
        approvals: [{ status: "pending" }],
        blockerSummary: { total: 1, requiringInformation: 1 },
      }).state,
    ).toBe("Failed");
    expect(
      project({
        run: { status: "waiting_approval" },
        blockerSummary: { total: 1, requiringInformation: 1 },
      }).state,
    ).toBe("Waiting approval");
    expect(project({ run: { status: "waiting_input" } }).state).toBe(
      "Need information",
    );
  });

  it("summarizes children and approvals while retaining supplied summaries", () => {
    const budgetSummary = { exhausted: false, remaining: 1200 } as const;
    const artifactSummary = { total: 2, pending: 1 } as const;
    const blockerSummary = { total: 1, requiringInformation: 0 } as const;

    expect(
      project({
        children: [
          { status: "running" },
          { status: "succeeded" },
          { status: "failed" },
        ],
        approvals: [
          { status: "pending" },
          { status: "approved" },
          { status: "rejected" },
        ],
        budgetSummary,
        artifactSummary,
        blockerSummary,
      }),
    ).toMatchObject({
      sourceStatus: "queued",
      childSummary: { total: 3, active: 1, completed: 2, succeeded: 1 },
      approvalSummary: { pending: 1, approved: 1, rejected: 1 },
      budgetSummary,
      artifactSummary,
      blockerSummary,
    });
  });

  it("is deterministic and does not mutate its inputs", () => {
    const input = {
      run: { status: "running" as const, startedAt: new Date(0) },
      children: [{ status: "succeeded" as const }],
      approvals: [{ status: "approved" as const }],
      goalRound: 1,
    } as const;
    const before = structuredClone(input);

    expect(buildRunProjection(input)).toEqual(buildRunProjection(input));
    expect(input).toEqual(before);
  });
});
