import type { AgentRunTable, DelegationRunTable } from "lib/db/pg/schema.pg";
import type { ResolvedPolicySnapshot } from "../runtime/contracts";
import type { RuntimeToolMode } from "../agent/runtime-context";

export type AgentRun = typeof AgentRunTable.$inferSelect;
export type DelegationRun = typeof DelegationRunTable.$inferSelect;
export type AgentRunStatus = AgentRun["status"];
export type TerminalAgentRunStatus = Exclude<
  AgentRunStatus,
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "waiting_external"
>;

export type RunOutcome =
  | { status: "succeeded"; result: Record<string, unknown> }
  | {
      status: "failed" | "cancelled" | "timed_out";
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
  idempotencyKey: string;
  toolCallId: string;
};

export type ParentRunCheckpoint = {
  delegationToolCallIds: string[];
  responseMessages: unknown[];
  modelMessages: unknown[];
  modelConfig: Record<string, unknown>;
  authorizationRecipe: Record<string, unknown> & {
    resolvedPolicy?: ResolvedPolicySnapshot;
    toolChoice?: RuntimeToolMode;
    autonomy?: "standard" | "ask" | "off";
  };
  assistantMessageId: string;
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
