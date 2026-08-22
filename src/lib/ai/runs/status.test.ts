import { describe, expect, test } from "vitest";
import {
  ACTIVE_AGENT_RUN_STATUSES,
  TERMINAL_AGENT_RUN_STATUSES,
  isActiveAgentRunStatus,
  isRetryableAgentRunStatus,
  isSuccessfulAgentRunStatus,
  isTerminalAgentRunStatus,
} from "./status";

describe("agent run status policy", () => {
  test("defines the canonical terminal and active partitions", () => {
    expect(TERMINAL_AGENT_RUN_STATUSES).toEqual([
      "succeeded",
      "failed",
      "cancelled",
      "timed_out",
      "budget_exhausted",
    ]);
    expect(ACTIVE_AGENT_RUN_STATUSES).not.toContain("budget_exhausted");
    expect(isTerminalAgentRunStatus("budget_exhausted")).toBe(true);
    expect(isActiveAgentRunStatus("budget_exhausted")).toBe(false);
  });

  test("treats only succeeded as successful and makes retries explicit", () => {
    expect(isSuccessfulAgentRunStatus("succeeded")).toBe(true);
    expect(isSuccessfulAgentRunStatus("failed")).toBe(false);
    expect(isRetryableAgentRunStatus("failed")).toBe(true);
    expect(isRetryableAgentRunStatus("timed_out")).toBe(true);
    expect(isRetryableAgentRunStatus("cancelled")).toBe(false);
    expect(isRetryableAgentRunStatus("budget_exhausted")).toBe(false);
  });
});
