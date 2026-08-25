import { describe, expect, test } from "vitest";
import type { DurableJob } from "./contracts";
import {
  CAPABILITY_ORCHESTRATION_JOB_TYPE,
  DurableJobTargetRegistry,
} from "./targets";

function job(target: DurableJob["target"], payload: unknown = {}) {
  return {
    id: "job-1",
    idempotencyKey: "request-1",
    target,
    payload,
    status: "running",
    attempt: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as DurableJob;
}

describe("durable job targets", () => {
  const registry = new DurableJobTargetRegistry();

  test.each([
    { kind: "agent", agentId: "agent-1" } as const,
    { kind: "workflow", workflowId: "workflow-1" } as const,
    { kind: "tool", toolName: "shell" } as const,
    { kind: "job", jobType: "unknown" } as const,
  ])("rejects unsupported target $kind", async (target) => {
    await expect(registry.execute(job(target))).rejects.toThrow(
      "DURABLE_JOB_TARGET_NOT_ALLOWED",
    );
  });

  test("pins the single bounded production orchestration target", () => {
    // The production registry is constructed only with the server target that
    // reconstructs persisted authorization; this assertion pins the allowed ID.
    expect(CAPABILITY_ORCHESTRATION_JOB_TYPE).toBe("capability-orchestration");
  });
});
