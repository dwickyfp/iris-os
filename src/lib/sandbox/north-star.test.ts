import { describe, expect, it, vi } from "vitest";
import type {
  SandboxInstance,
  SandboxRepository,
  SandboxSessionRecord,
} from "./contracts";
import { SandboxManager } from "./manager";

describe("Harness sandbox north star", () => {
  it("executes compute, publishes an artifact, records usage, and cleans up", async () => {
    const sessions: SandboxSessionRecord[] = [];
    const repository: SandboxRepository = {
      claimSession: vi.fn(async (session) => {
        const existing = sessions[0];
        if (existing)
          return {
            session: existing,
            claimed: false,
            rootRunId: session.runId,
          };
        sessions.push(session);
        return { session, claimed: true, rootRunId: session.runId };
      }),
      activateSession: vi.fn(
        async (
          id,
          _creatorToken,
          providerInstanceId,
          _expiresAt,
          activatedAt,
        ) => {
          Object.assign(sessions.find((session) => session.id === id)!, {
            status: "active",
            providerInstanceId,
            lastUsedAt: activatedAt,
          });
          return true;
        },
      ),
      failSessionCreation: vi.fn(async () => undefined),
      cancelSessionsByRun: vi.fn(async () => {
        sessions[0].status = "cancelled";
        return sessions;
      }),
      cancelSessionsByRootRun: vi.fn(async () => sessions),
      touchSession: vi.fn(async () => true),
      finishSession: vi.fn(async () => undefined),
      claimExpiredSessions: vi.fn(async () => []),
      listSessionsForReconciliation: vi.fn(async () => []),
      reconcileSession: vi.fn(async () => "rejected" as const),
      retainSessionAfterLookup: vi.fn(async () => true),
      markSessionLost: vi.fn(async () => true),
      reconcileStaleExecutions: vi.fn(async () => 0),
      reserveExecution: vi.fn(async () => true),
      startExecution: vi.fn(async () => true),
      releaseExecution: vi.fn(async () => true),
      settleExecution: vi.fn(async () => true),
      finishExecution: vi.fn(async () => true),
      cancelRunningExecutions: vi.fn(async () => undefined),
    };
    const instance: SandboxInstance = {
      id: "runsc-session",
      profile: {} as any,
      executePython: vi.fn(async () => ({
        executionId: "provider-exec",
        exitCode: 0,
        stdout: "trend=12.5%\n",
        stderr: "",
        durationMs: 250,
        files: [
          {
            path: "output/trend.json",
            content: Buffer.from('{"trend":12.5}').toString("base64"),
            encoding: "base64" as const,
            mediaType: "application/json",
          },
        ],
      })),
      cancel: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
    };
    const events: string[] = [];
    const manager = new SandboxManager({
      provider: {
        name: "iris-runner",
        status: vi.fn(async () => ({
          ready: true,
          provider: "iris-runner",
          checkedAt: new Date(),
        })),
        create: vi.fn(async () => instance),
        connect: vi.fn(async () => instance),
        inventory: vi.fn(async () => ({
          bootId: "boot-1",
          capturedAt: new Date().toISOString(),
          sessions: [],
        })),
      },
      repository,
      policy: { authorize: vi.fn(async () => undefined) },
      events: {
        record: vi.fn(async ({ type }) => {
          events.push(type);
        }),
      },
      artifacts: {
        capture: vi.fn(async ({ files }) => [
          { artifactId: "artifact-1", filename: files[0].path },
        ]),
      },
    });
    const result = await manager.executePython({
      scope: { runId: "root-run", userId: "user-1" },
      profile: {
        id: "data_compute",
        cpuMillis: 1_000,
        memoryMb: 512,
        diskMb: 1_024,
        executionTimeoutMs: 1_000,
        idleTimeoutMs: 3_000,
        absoluteTimeoutMs: 15_000,
        network: "none",
      },
      request: {
        code: "print('trend=12.5%')",
        outputPaths: ["output/trend.json"],
      },
      maxComputeMs: 1_000,
    });

    expect(result.artifacts).toEqual([
      { artifactId: "artifact-1", filename: "output/trend.json" },
    ]);
    expect(repository.settleExecution).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      250,
      250,
      expect.any(Date),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        "sandbox.session_created",
        "sandbox.execution_started",
        "sandbox.execution_completed",
      ]),
    );
    await manager.cancelByRun("root-run");
    expect(instance.destroy).toHaveBeenCalledOnce();
  });
});
