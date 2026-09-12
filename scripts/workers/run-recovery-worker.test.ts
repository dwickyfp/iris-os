import type { AgentRun } from "lib/ai/runs/types";
import { describe, expect, test, vi } from "vitest";
import {
  createRunRecoverySweep,
  recordReapedTerminalEvent,
} from "./run-recovery-worker";

vi.mock("lib/activity/service", () => ({
  recordActivityEvent: vi.fn(async () => undefined),
}));
vi.mock("lib/ai/runs/server", () => ({ runManager: {} }));
vi.mock("lib/db/pg/db.pg", () => ({ pgDb: { execute: vi.fn() } }));
vi.mock("lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function fakeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    userId: "user-1",
    status: "timed_out",
    depth: 0,
    errorCode: "LEASE_EXPIRED",
    error: "Run lease expired without a terminal transition (executor lost)",
    completedAt: new Date("2026-01-01T00:00:00Z"),
    createdAt: new Date("2025-12-31T23:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    rootRunId: "run-1",
    goal: "test",
    goalRevision: 0,
    budget: null,
    context: null,
    policy: null,
    runType: "foreground",
    ...overrides,
  } as AgentRun;
}

const { recordActivityEvent } = (await import(
  "lib/activity/service"
)) as unknown as {
  recordActivityEvent: ReturnType<typeof vi.fn>;
};

describe("createRunRecoverySweep", () => {
  test("records a terminal event for every reaped run", async () => {
    vi.clearAllMocks();
    const reaped = [fakeRun(), fakeRun({ id: "run-2", userId: "user-2" })];
    const sweep = createRunRecoverySweep({
      reapStaleForegroundRuns: vi.fn(async () => reaped),
      recordTerminalEvent: recordReapedTerminalEvent,
    });
    const count = await sweep();
    expect(count).toBe(2);
    expect(recordActivityEvent).toHaveBeenCalledTimes(2);
    const [userId, event] = recordActivityEvent.mock.calls[0];
    expect(userId).toBe("user-1");
    expect(event.eventType).toBe("run.failed");
    expect(event.idempotencyKey).toBe("run-terminal:run-1");
    expect(event.payload.errorCode).toBe("LEASE_EXPIRED");
    expect(event.subjectType).toBe("agent_run");
    expect(event.actorType).toBe("system");
  });

  test("continues recording when one event write fails", async () => {
    vi.clearAllMocks();
    recordActivityEvent.mockRejectedValueOnce(new Error("db down"));
    const sweep = createRunRecoverySweep({
      reapStaleForegroundRuns: vi.fn(async () => [
        fakeRun({ id: "run-a" }),
        fakeRun({ id: "run-b" }),
      ]),
      recordTerminalEvent: recordReapedTerminalEvent,
    });
    const count = await sweep();
    expect(count).toBe(2);
    expect(recordActivityEvent).toHaveBeenCalledTimes(2);
  });

  test("skips non-terminal runs returned by the repository", async () => {
    vi.clearAllMocks();
    await recordReapedTerminalEvent(fakeRun({ status: "running" }));
    expect(recordActivityEvent).not.toHaveBeenCalled();
  });
});
