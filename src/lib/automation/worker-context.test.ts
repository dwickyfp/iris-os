import { describe, expect, test, vi } from "vitest";
import {
  buildAutomationWorkerRequest,
  resolveWorkerAutomationAuthority,
} from "./worker-context";

vi.mock("server-only", () => ({}));

describe("automation worker authority", () => {
  test("can only shrink an authorization-time grant", () => {
    expect(
      resolveWorkerAutomationAuthority({
        persisted: {
          version: 1,
          allowedTools: ["approved", "removed"],
          capabilityIds: ["tool:approved", "tool:removed"],
        },
        current: {
          version: 1,
          allowedTools: ["approved", "added"],
          capabilityIds: ["tool:approved", "tool:added"],
        },
      }),
    ).toEqual({
      version: 1,
      allowedTools: ["approved"],
      capabilityIds: ["tool:approved"],
    });
  });

  test("preserves an explicitly empty grant", () => {
    expect(
      resolveWorkerAutomationAuthority({
        persisted: { version: 1, allowedTools: [], capabilityIds: [] },
        current: {
          version: 1,
          allowedTools: ["current"],
          capabilityIds: ["tool:current"],
        },
      }),
    ).toEqual({ version: 1, allowedTools: [], capabilityIds: [] });
  });

  test("fails closed for a legacy run without a snapshot", () => {
    expect(() =>
      resolveWorkerAutomationAuthority({
        persisted: null,
        current: { version: 1, allowedTools: [], capabilityIds: [] },
      }),
    ).toThrow("AUTOMATION_AUTHORITY_SNAPSHOT_MISSING");
  });

  test("contains identifiers only and no target credentials", () => {
    const snapshot = resolveWorkerAutomationAuthority({
      persisted: {
        version: 1,
        allowedTools: ["query"],
        capabilityIds: ["mcp:warehouse:query"],
      },
      current: {
        version: 1,
        allowedTools: ["query"],
        capabilityIds: ["mcp:warehouse:query"],
      },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|token|header|credential/i);
  });

  test("passes the exact persisted effective grant to the adapter", () => {
    const authority = {
      version: 1 as const,
      allowedTools: ["approved"],
      capabilityIds: ["builtin:approved"],
    };
    const signal = new AbortController().signal;
    expect(
      buildAutomationWorkerRequest({
        run: { id: "run-1" },
        automation: {
          userId: "user-1",
          workspaceId: null,
          targetType: "agent",
          targetId: "agent-1",
          input: {},
          timeoutMs: 1_000,
        },
        authority,
        signal,
      }),
    ).toMatchObject({
      runId: "run-1",
      allowedTools: ["approved"],
      authoritySnapshot: authority,
      signal,
    });
  });
});
