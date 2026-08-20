import type { ActivityEventInput } from "app-types/activity";
import type { StartRunInput } from "../runs/types";
import type { ParentRunCheckpoint } from "../runs/types";
import type {
  ContextDiagnostics,
  ContextProvenance,
  ContextSourceRecord,
} from "./context-engine";
import type {
  PolicyAuthority,
  PolicyCapability,
  PolicyDecision,
} from "./policy-engine";
import type { CompletionRequirement, VerificationResult } from "./verification";
import type { RunBudget } from "./budget";

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
  sourceRecords?: ContextSourceRecord[];
  estimatedTokens?: number;
  truncatedSources?: string[];
  trustBoundaries?: string[];
};

export type ResolvedPolicySnapshot = {
  version?: 2;
  approvalPolicy: "always" | "destructive_only" | "never";
  tools: Record<string, PolicyDecision>;
  capabilities?: Record<string, PolicyCapability>;
  authority?: PolicyAuthority;
};

export type HarnessRunSpec = Omit<StartRunInput, "id" | "userId">;

export type HarnessOrchestration = {
  identity: HarnessIdentity;
  run:
    | { mode: "create"; spec: HarnessRunSpec }
    | { mode: "claimed"; claimToken: string };
  context?: ContextPreparation;
  policy?: ResolvedPolicySnapshot;
  completionRequirement?: CompletionRequirement;
  budget?: RunBudget;
  sandbox?: unknown;
};

export type HarnessFailure = {
  error: unknown;
  errorCode?: string;
  status?: "failed" | "cancelled" | "timed_out" | "budget_exhausted";
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
  recordRuntime(
    userId: string,
    event: Omit<ActivityEventInput, "idempotencyKey" | "occurrenceId">,
  ): Promise<unknown>;
}
