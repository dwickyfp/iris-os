import type { AgentRunTable, DelegationRunTable } from "lib/db/pg/schema.pg";
import type { RuntimeToolMode } from "../agent/runtime-context";
import type { RunBudget } from "../runtime/budget";
import type { ResolvedPolicySnapshot } from "../runtime/contracts";
import type { NormalizedGoalRequirement } from "../runtime/goal-requirement-resolver";
import type { RunPreparationSnapshot } from "../runtime/run-preparer";

export type AgentRun = typeof AgentRunTable.$inferSelect;
export type DelegationRun = typeof DelegationRunTable.$inferSelect;
export type AgentRunStatus = AgentRun["status"];

export type RunOutcome =
  | { status: "succeeded"; result: Record<string, unknown> }
  | {
      status: "failed" | "cancelled" | "timed_out" | "budget_exhausted";
      error?: string;
      errorCode?: string;
    };

export type StartRunInput = {
  id: string;
  userId: string;
  agentId?: string;
  parentRunId?: string;
  workspaceId?: string;
  taskId?: string;
  context?: Record<string, unknown>;
  allowedTools?: string[];
  timeoutMs?: number;
  depth?: number;
  tokenBudget?: number;
  budget?: RunBudget;
  goalRequirement?: NormalizedGoalRequirement;
};

export type QueueDelegatedRunInput = {
  id: string;
  delegationId: string;
  userId: string;
  agentId?: string;
  target:
    | { kind: "local"; agentId: string }
    | { kind: "remote"; connectionId: string };
  parentRunId: string;
  workspaceId?: string;
  taskId?: string;
  objective: string;
  context: Record<string, unknown>;
  allowedTools: string[];
  timeoutMs: number;
  depth: number;
  tokenBudget: number;
  budget?: RunBudget;
  idempotencyKey: string;
  toolCallId: string;
};

export type ParentRunCheckpoint = {
  /** Legacy checkpoint compatibility; new reads use AgentRun.goalRequirement. */
  goalRequirement?: NormalizedGoalRequirement;
  continuationKind?: "delegation" | "goal";
  goalRound?: number;
  maxGoalRounds?: number;
  verificationFeedback?: Record<string, unknown>;
  delegationToolCallIds: string[];
  responseMessages: unknown[];
  modelMessages: unknown[];
  modelConfig: Record<string, unknown>;
  authorizationRecipe: Record<string, unknown> & {
    resolvedPolicy?: ResolvedPolicySnapshot;
    toolChoice?: RuntimeToolMode;
    autonomy?: "standard" | "ask" | "off";
    routingSnapshot?: RunPreparationSnapshot["routing"];
    budgetSnapshot?: RunPreparationSnapshot["budget"];
    completionSnapshot?: RunPreparationSnapshot["completion"];
    contextSnapshot?: RunPreparationSnapshot["context"];
    modelSnapshot?: RunPreparationSnapshot["model"];
    driverSnapshot?: RunPreparationSnapshot["driver"];
  };
  assistantMessageId?: string;
};

export type ClaimedParentRun = {
  run: AgentRun;
  checkpoint: ParentRunCheckpoint & { generation: number };
  joins: Array<{
    checkpointGeneration: number;
    toolCallId: string;
    childRunId: string;
    observation: Record<string, unknown>;
  }>;
  token: string;
};

export type RunLease = {
  run: AgentRun;
  token: string;
};

export type RunLeaseState = "active" | "cancelled" | "timed_out" | "lease_lost";

export type RunContinuation =
  | {
      kind: "input";
      submissionId?: string;
      messageId?: string;
      payload: Record<string, unknown>;
    }
  | {
      kind: "credential";
      submissionId?: string;
      messageId?: string;
      encryptedCredential: string;
    };

export type ResumeRunInput = {
  runId: string;
  userId: string;
  continuation: RunContinuation;
};

export type RemoteSubmissionIntent = {
  submissionId: string;
  messageId: string;
  payload: Record<string, unknown>;
  remoteTaskId: string | null;
  remoteContextId: string | null;
};

export type RemoteCancellationIntent = {
  userId: string;
  remoteAgentId: string;
  remoteTaskId: string;
  encryptedCredential: string | null;
};
