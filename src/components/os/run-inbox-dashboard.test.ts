import { describe, expect, it } from "vitest";
import { runInboxSummary } from "./run-inbox-dashboard";

const item = {
  id: "item-id",
  rootRunId: "root-id",
  targetRunId: "target-id",
  mode: "inject" as const,
  source: "system" as const,
  status: "open" as const,
  goalRevision: 2,
  createdAt: "2026-08-24T00:00:00.000Z",
};

describe("runInboxSummary", () => {
  it("shows a recognized user-safe string field", () => {
    expect(
      runInboxSummary({ ...item, content: { objective: "Check the totals" } }),
    ).toBe("Check the totals");
  });

  it("does not render arbitrary structured inbox content", () => {
    expect(
      runInboxSummary({ ...item, content: { secret: "not for projection" } }),
    ).toBe("New context is available for this run.");
  });
});
