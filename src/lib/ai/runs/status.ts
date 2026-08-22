import type { AgentRunStatus } from "./types";

export const ACTIVE_AGENT_RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
  "waiting_external",
] as const satisfies readonly AgentRunStatus[];

export const TERMINAL_AGENT_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "budget_exhausted",
] as const satisfies readonly AgentRunStatus[];

export const SUCCESSFUL_AGENT_RUN_STATUSES = [
  "succeeded",
] as const satisfies readonly AgentRunStatus[];

// A terminal run may be retried only for an execution failure or timeout.
// Cancellation, success, and exhausted budgets require a new run or budget.
export const RETRYABLE_AGENT_RUN_STATUSES = [
  "failed",
  "timed_out",
] as const satisfies readonly AgentRunStatus[];

export type TerminalAgentRunStatus =
  (typeof TERMINAL_AGENT_RUN_STATUSES)[number];

function includesStatus<T extends AgentRunStatus>(
  statuses: readonly T[],
  status: AgentRunStatus,
): status is T {
  return (statuses as readonly AgentRunStatus[]).includes(status);
}

export function isActiveAgentRunStatus(status: AgentRunStatus) {
  return includesStatus(ACTIVE_AGENT_RUN_STATUSES, status);
}

export function isTerminalAgentRunStatus(
  status: AgentRunStatus,
): status is TerminalAgentRunStatus {
  return includesStatus(TERMINAL_AGENT_RUN_STATUSES, status);
}

export function isSuccessfulAgentRunStatus(status: AgentRunStatus) {
  return includesStatus(SUCCESSFUL_AGENT_RUN_STATUSES, status);
}

export function isRetryableAgentRunStatus(status: AgentRunStatus) {
  return includesStatus(RETRYABLE_AGENT_RUN_STATUSES, status);
}

export function summarizeAgentRunStatuses(
  runs: ReadonlyArray<{
    status: AgentRunStatus;
    cancelRequestedAt: Date | null;
  }>,
) {
  return {
    active: runs.filter((run) => isActiveAgentRunStatus(run.status)).length,
    failed: runs.filter(
      (run) =>
        run.status === "failed" ||
        run.status === "timed_out" ||
        run.status === "budget_exhausted",
    ).length,
    retryable: runs.filter((run) => isRetryableAgentRunStatus(run.status))
      .length,
    cancellable: runs.filter(
      (run) =>
        isActiveAgentRunStatus(run.status) && run.cancelRequestedAt === null,
    ).length,
  };
}
