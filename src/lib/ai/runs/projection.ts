import type { AgentRunStatus } from "./types";

export const RUN_PROJECTION_STATES = [
  "Understanding request",
  "Gathering information",
  "Working with specialist",
  "Comparing results",
  "Preparing output",
  "Waiting approval",
  "Need information",
  "Completed",
  "Failed",
  "Cancelled",
] as const;

export type RunProjectionState = (typeof RUN_PROJECTION_STATES)[number];

export type RunProjectionRun = Readonly<{
  status: AgentRunStatus;
  startedAt?: Date | null;
}>;

export type RunProjectionChild = Readonly<{
  status: AgentRunStatus;
}>;

export type RunProjectionApproval = Readonly<{
  status: "pending" | "approved" | "rejected";
}>;

export type RunBudgetSummary = Readonly<{
  exhausted: boolean;
  remaining?: number;
}>;

export type RunArtifactSummary = Readonly<{
  total: number;
  pending?: number;
}>;

export type RunBlockerSummary = Readonly<{
  total: number;
  requiringInformation?: number;
}>;

export type RunProjectionInput = Readonly<{
  run: RunProjectionRun;
  goalRound?: number;
  revision?: number;
  children?: readonly RunProjectionChild[];
  approvals?: readonly RunProjectionApproval[];
  budgetSummary?: RunBudgetSummary;
  artifactSummary?: RunArtifactSummary;
  blockerSummary?: RunBlockerSummary;
}>;

export type RunProjection = Readonly<{
  state: RunProjectionState;
  sourceStatus: AgentRunStatus;
  goalRound: number;
  revision: number;
  childSummary: Readonly<{
    total: number;
    active: number;
    completed: number;
    succeeded: number;
  }>;
  approvalSummary: Readonly<{
    pending: number;
    approved: number;
    rejected: number;
  }>;
  budgetSummary: RunBudgetSummary | null;
  artifactSummary: RunArtifactSummary | null;
  blockerSummary: RunBlockerSummary | null;
}>;

const ACTIVE_STATUSES: readonly AgentRunStatus[] = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
  "waiting_external",
];

const TERMINAL_STATUSES: readonly AgentRunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "budget_exhausted",
];

/** Builds display state from authoritative run data without changing run truth. */
export function buildRunProjection(input: RunProjectionInput): RunProjection {
  const children = input.children ?? [];
  const approvals = input.approvals ?? [];
  const goalRound = input.goalRound ?? 1;
  const revision = input.revision ?? 0;
  const activeChildren = children.filter((child) =>
    ACTIVE_STATUSES.includes(child.status),
  ).length;
  const completedChildren = children.filter((child) =>
    TERMINAL_STATUSES.includes(child.status),
  ).length;
  const succeededChildren = children.filter(
    (child) => child.status === "succeeded",
  ).length;
  const pendingApprovals = approvals.filter(
    (approval) => approval.status === "pending",
  ).length;
  const requiringInformation = input.blockerSummary?.requiringInformation ?? 0;

  let state: RunProjectionState;
  if (input.run.status === "succeeded") {
    state = "Completed";
  } else if (input.run.status === "cancelled") {
    state = "Cancelled";
  } else if (TERMINAL_STATUSES.includes(input.run.status)) {
    state = "Failed";
  } else if (input.run.status === "waiting_approval" || pendingApprovals > 0) {
    state = "Waiting approval";
  } else if (input.run.status === "waiting_input" || requiringInformation > 0) {
    state = "Need information";
  } else if (activeChildren > 0) {
    state = "Working with specialist";
  } else if ((input.artifactSummary?.total ?? 0) > 0) {
    state = "Preparing output";
  } else if (revision > 0 || goalRound > 1 || succeededChildren > 1) {
    state = "Comparing results";
  } else if (completedChildren > 0) {
    state = "Preparing output";
  } else if (
    input.run.status === "waiting_external" ||
    input.run.status === "running" ||
    input.run.startedAt
  ) {
    state = "Gathering information";
  } else {
    state = "Understanding request";
  }

  return {
    state,
    sourceStatus: input.run.status,
    goalRound,
    revision,
    childSummary: {
      total: children.length,
      active: activeChildren,
      completed: completedChildren,
      succeeded: succeededChildren,
    },
    approvalSummary: {
      pending: pendingApprovals,
      approved: approvals.filter((approval) => approval.status === "approved")
        .length,
      rejected: approvals.filter((approval) => approval.status === "rejected")
        .length,
    },
    budgetSummary: input.budgetSummary ?? null,
    artifactSummary: input.artifactSummary ?? null,
    blockerSummary: input.blockerSummary ?? null,
  };
}
