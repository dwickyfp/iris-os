import { describe, expect, test, vi } from "vitest";
import type { CapabilityDescriptor } from "./capabilities/registry";
import type { PolicyEvaluationDecision } from "./policy-engine";
import type { ResultSurface } from "./result-surface";
import {
  type AuthorizedCapabilityDescriptor,
  MAX_SERVER_ORCHESTRATION_CONCURRENCY,
  executeServerOrchestrationPlan,
} from "./server-orchestration-executor";

vi.mock("server-only", () => ({}));

function decision(
  id: string,
  result: PolicyEvaluationDecision["result"] = "allow",
): PolicyEvaluationDecision {
  return {
    version: 2,
    decisionId: `decision:${id}`,
    result,
    risks: ["read"],
    reasons: [],
    actor: { type: "system" },
    capability: { id, key: id },
    action: "execute",
    resource: id,
    destination: { kind: "local" },
    runtime: { kind: "worker", approvalPolicy: "never" },
  };
}

function descriptor(
  id: string,
  options: {
    concurrency?: "parallel" | "exclusive";
    approval?: PolicyEvaluationDecision["result"];
  } = {},
): AuthorizedCapabilityDescriptor {
  const capability: CapabilityDescriptor = {
    id,
    key: id,
    kind: "builtin",
    name: id,
    surfaces: ["executable"],
    value: { trusted: id },
  };
  return {
    capability,
    concurrency: options.concurrency ?? "parallel",
    approvalDecision: decision(id, options.approval),
  };
}

function surface(id: string): ResultSurface {
  const ownership = { userId: "user", runId: "run" };
  const provenance = [{ sourceId: id }];
  return {
    mode: "inline",
    content: `bounded:${id}`,
    ownership,
    trust: "untrusted",
    provenance,
    ref: {
      id,
      key: `result/${id}`,
      mediaType: "text/plain",
      byteLength: id.length,
      estimatedTokens: 1,
      ownership,
      trust: "untrusted",
      provenance,
    },
  };
}

function plan(...ids: string[]) {
  return {
    version: 1 as const,
    steps: [
      {
        calls: ids.map((id) => ({ id, capabilityId: id })),
      },
    ],
  };
}

function options(
  authorizedDescriptors: ReadonlyMap<string, AuthorizedCapabilityDescriptor>,
  overrides: Record<string, unknown> = {},
) {
  return {
    maxConcurrency: 2,
    authorizedDescriptors,
    invoker: {
      handlesDurableApproval: false,
      invoke: vi.fn(({ callId }) => ({ secret: callId })),
    },
    assertCurrentRevision: vi.fn(),
    projectResult: vi.fn((_result, { call }) => surface(call.id)),
    ...overrides,
  };
}

describe("executeServerOrchestrationPlan", () => {
  test("validates every capability against the authorized descriptor map", async () => {
    const configured = options(new Map([["allowed", descriptor("allowed")]]));

    await expect(
      executeServerOrchestrationPlan(plan("allowed", "missing"), configured),
    ).rejects.toThrow("Capability is not authorized: missing");
    expect(configured.invoker.invoke).not.toHaveBeenCalled();
    expect(configured.assertCurrentRevision).not.toHaveBeenCalled();

    const mismatched = options(
      new Map([["expected", descriptor("different")]]),
    );
    await expect(
      executeServerOrchestrationPlan(plan("expected"), mismatched),
    ).rejects.toThrow("Authorized descriptor ID mismatch: expected");

    const invalidConcurrency = descriptor("allowed");
    (invalidConcurrency as { concurrency: string }).concurrency = "untrusted";
    await expect(
      executeServerOrchestrationPlan(
        plan("allowed"),
        options(new Map([["allowed", invalidConcurrency]])),
      ),
    ).rejects.toThrow("Invalid concurrency metadata: allowed");

    const mismatchedDecision = descriptor("allowed");
    mismatchedDecision.approvalDecision = decision("different");
    await expect(
      executeServerOrchestrationPlan(
        plan("allowed"),
        options(new Map([["allowed", mismatchedDecision]])),
      ),
    ).rejects.toThrow("Approval decision capability mismatch: allowed");
  });

  test("fails closed on denied and unhandled approval decisions", async () => {
    const denied = options(
      new Map([["write", descriptor("write", { approval: "deny" })]]),
    );
    await expect(
      executeServerOrchestrationPlan(plan("write"), denied),
    ).rejects.toThrow("Capability was denied: write");
    expect(denied.invoker.invoke).not.toHaveBeenCalled();

    const approval = options(
      new Map([["write", descriptor("write", { approval: "approval" })]]),
    );
    await expect(
      executeServerOrchestrationPlan(plan("write"), approval),
    ).rejects.toThrow("Capability requires durable approval: write");
    expect(approval.invoker.invoke).not.toHaveBeenCalled();

    const malformed = descriptor("write");
    (
      malformed.approvalDecision as unknown as {
        result: string;
      }
    ).result = "unknown";
    await expect(
      executeServerOrchestrationPlan(
        plan("write"),
        options(new Map([["write", malformed]])),
      ),
    ).rejects.toThrow("Invalid approval decision: write");
  });

  test("passes approval decisions only to an invoker with durable handling", async () => {
    const approvedDescriptor = descriptor("write", { approval: "approval" });
    const invoke = vi.fn(() => ({ ok: true }));
    const configured = options(new Map([["write", approvedDescriptor]]), {
      invoker: { handlesDurableApproval: true, invoke },
    });

    await executeServerOrchestrationPlan(plan("write"), configured);

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: approvedDescriptor.capability,
        approvalDecision: approvedDescriptor.approvalDecision,
      }),
    );
  });

  test("uses trusted concurrency metadata and enforces the hard bound", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const invoke = vi.fn(async ({ callId }: { callId: string }) => {
      events.push(`${callId}:start`);
      if (callId === "first") await firstGate;
      events.push(`${callId}:end`);
      return callId;
    });
    const configured = options(
      new Map([
        ["first", descriptor("first")],
        ["barrier", descriptor("barrier", { concurrency: "exclusive" })],
        ["last", descriptor("last")],
      ]),
      { maxConcurrency: 3, invoker: { handlesDurableApproval: false, invoke } },
    );
    const execution = executeServerOrchestrationPlan(
      plan("first", "barrier", "last"),
      configured,
    );
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await execution;
    expect(events).toEqual([
      "first:start",
      "first:end",
      "barrier:start",
      "barrier:end",
      "last:start",
      "last:end",
    ]);

    await expect(
      executeServerOrchestrationPlan(plan("first"), {
        ...configured,
        maxConcurrency: MAX_SERVER_ORCHESTRATION_CONCURRENCY + 1,
      }),
    ).rejects.toThrow("maxConcurrency must be an integer between 1 and 8");
  });

  test("asserts the current revision immediately before each call and commit", async () => {
    const events: string[] = [];
    const assertCurrentRevision = vi.fn(() => events.push("assert"));
    const invoke = vi.fn(({ callId }) => {
      events.push(`invoke:${callId}`);
      return callId;
    });
    const projectResult = vi.fn((_result, { call }) => {
      events.push(`project:${call.id}`);
      return surface(call.id);
    });
    const onCommit = vi.fn(({ call }) => events.push(`commit:${call.id}`));
    const configured = options(
      new Map([
        ["one", descriptor("one")],
        ["two", descriptor("two")],
      ]),
      {
        maxConcurrency: 1,
        invoker: { handlesDurableApproval: false, invoke },
        assertCurrentRevision,
        projectResult,
        onCommit,
      },
    );

    await executeServerOrchestrationPlan(plan("one", "two"), configured);

    expect(events).toEqual([
      "assert",
      "invoke:one",
      "assert",
      "invoke:two",
      "assert",
      "project:one",
      "assert",
      "commit:one",
      "assert",
      "project:two",
      "assert",
      "commit:two",
    ]);
  });

  test("passes only the bounded result surface to downstream calls", async () => {
    const raw = { secret: "complete upstream evidence" };
    const bounded = surface("research");
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(raw)
      .mockResolvedValueOnce({ summary: true });
    const projectResult = vi
      .fn()
      .mockResolvedValueOnce(bounded)
      .mockResolvedValueOnce(surface("summary"));
    const configured = options(
      new Map([
        ["research", descriptor("research")],
        ["summary", descriptor("summary")],
      ]),
      {
        invoker: { handlesDurableApproval: false, invoke },
        projectResult,
      },
    );

    const results = await executeServerOrchestrationPlan(
      {
        version: 1,
        steps: [
          { calls: [{ id: "research", capabilityId: "research" }] },
          {
            calls: [
              {
                id: "summary",
                capabilityId: "summary",
                inputFrom: "research",
              },
            ],
          },
        ],
      },
      configured,
    );

    expect(invoke).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ input: bounded }),
    );
    expect(invoke.mock.calls[1][0].input).not.toBe(raw);
    expect(results[0].result).toBe(bounded);
  });
});
