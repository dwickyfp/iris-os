import type { AutomationAuthoritySnapshot } from "./authority";
import { intersectAutomationAuthority } from "./authority";
import type { AutomationExecutionRequest } from "./execution-adapter";

export function resolveWorkerAutomationAuthority(input: {
  persisted: AutomationAuthoritySnapshot | null;
  current: AutomationAuthoritySnapshot;
}) {
  if (!input.persisted) throw new Error("AUTOMATION_AUTHORITY_SNAPSHOT_MISSING");
  return intersectAutomationAuthority(input.persisted, input.current);
}

export function buildAutomationWorkerRequest(input: {
  run: { id: string };
  automation: {
    userId: string;
    workspaceId: string | null;
    targetType: "workflow" | "skill" | "agent";
    targetId: string;
    input: Record<string, unknown>;
    timeoutMs: number;
  };
  authority: AutomationAuthoritySnapshot;
  signal: AbortSignal;
}): AutomationExecutionRequest {
  return {
    runId: input.run.id,
    userId: input.automation.userId,
    workspaceId: input.automation.workspaceId ?? undefined,
    targetType: input.automation.targetType,
    targetId: input.automation.targetId,
    input: input.automation.input,
    timeoutMs: input.automation.timeoutMs,
    signal: input.signal,
    executionSource: "automation",
    allowedTools: input.authority.allowedTools,
    authoritySnapshot: input.authority,
  };
}
