import type { ActivityEventInput } from "app-types/activity";
import type { StartRunInput } from "../runs/types";
import type { ParentRunCheckpoint } from "../runs/types";
import type { ContextDiagnostics, ContextProvenance } from "./context-engine";
import type { PolicyDecision } from "./policy-engine";
import type { CompletionRequirement, VerificationResult } from "./verification";

export type HarnessIdentity = {
  userId: string;
  runId: string;
  requestId: string;
  actorType?: "agent" | "system";
  actorId?: string;
  threadId?: string;
  agentId?: string;
  taskId?: string;
  workspaceId?: string;
  parentRunId?: string;
};

export type ContextPreparation = {
  provenance: ContextProvenance[];
  diagnostics: ContextDiagnostics;
};

export type ResolvedPolicySnapshot = {
  approvalPolicy: "always" | "destructive_only" | "never";
  tools: Record<string, PolicyDecision>;
};

export type HarnessRunSpec = Omit<StartRunInput, "id" | "userId">;

export type HarnessOrchestration = {
  identity: HarnessIdentity;
  /** Omit during migration when no durable agent run should be created. */
  run?: HarnessRunSpec;
  context?: ContextPreparation;
  policy?: ResolvedPolicySnapshot;
  completionRequirement?: CompletionRequirement;
};

export type HarnessFailure = {
  error: unknown;
  errorCode?: string;
  status?: "failed" | "cancelled" | "timed_out";
};

export type HarnessFinalization = {
  result?: Record<string, unknown>;
  verification?: VerificationResult[];
};

export type HarnessStreamResult<Native> = {
  /** The exact object returned by the execution driver. */
  native: Native;
  finalize(
    value?: unknown,
    result?: Record<string, unknown>,
  ): Promise<HarnessFinalization>;
  fail(failure: HarnessFailure | unknown): Promise<void>;
  waitForExternal(checkpoint: ParentRunCheckpoint): Promise<void>;
};

export interface HarnessEventRecorder {
  record(userId: string, event: ActivityEventInput): Promise<unknown>;
}
