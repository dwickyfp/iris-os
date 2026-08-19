import { eq } from "drizzle-orm";
import { recordRuntimeActivityEvent } from "lib/activity/service";
import {
  ArtifactService,
  createArtifactVerifier,
  ingestRemoteArtifacts,
} from "lib/ai/artifacts";
import { runManager } from "lib/ai/runs/server";
import type { AgentRun } from "lib/ai/runs/types";
import { createAutomationExecutionAdapter } from "lib/automation/execution-adapter";
import { pgDb } from "lib/db/pg/db.pg";
import { DelegationRunTable } from "lib/db/pg/schema.pg";
import { agentRunRepository, artifactRepository } from "lib/db/repository";
import {
  DELEGATION_EXECUTE_QUEUE,
  DELEGATION_REMOTE_CANCEL_QUEUE,
  DELEGATION_SWEEP_QUEUE,
  enqueueDelegatedRun,
  enqueueRemoteCancellation,
} from "lib/delegation/queue";
import { DELEGATION_LIMITS } from "lib/delegation/service";
import {
  type DelegationWorkerEvent,
  createDelegationWorkerExecutor,
} from "lib/delegation/worker-executor";
import { serverFileStorage } from "lib/file-storage";
import { remoteAgentService } from "lib/remote-agent/server";
import { decryptRemoteAgentSecret } from "lib/security/secrets";
import type PgBoss from "pg-boss";
import { enqueueParentResume } from "lib/ai/runs/parent-resume-queue";

const executeTarget = createAutomationExecutionAdapter();
const artifacts = new ArtifactService(serverFileStorage, artifactRepository);
const artifactVerifier = createArtifactVerifier(
  serverFileStorage,
  artifactRepository,
);

const execute = createDelegationWorkerExecutor({
  runs: runManager,
  selectRun: (id) => agentRunRepository.selectById(id),
  selectDelegation: async (childRunId) => {
    const [delegation] = await pgDb
      .select({
        targetKind: DelegationRunTable.targetKind,
        remoteAgentId: DelegationRunTable.remoteAgentId,
      })
      .from(DelegationRunTable)
      .where(eq(DelegationRunTable.childRunId, childRunId));
    return delegation ?? null;
  },
  remote: remoteAgentService,
  executeLocal: executeTarget,
  enqueue: enqueueDelegatedRun,
  markDispatched: (runId) => runManager.markDispatched(runId),
  decryptCredential: decryptRemoteAgentSecret,
  recordEvent,
  ingestRemoteArtifacts: (claimed, owner) =>
    ingestRemoteArtifacts(claimed, owner, {
      artifacts,
      verify: artifactVerifier.verify.bind(artifactVerifier),
    }),
});

async function recordEvent(event: DelegationWorkerEvent) {
  if (event.kind === "terminal") return recordTerminalEvent(event.child);
  if (event.kind === "remote")
    return recordRemoteEvent(
      event.child,
      event.eventType,
      event.toStatus,
      event.payload,
    );
  const { child, parent, delegation } = event;
  await recordRuntimeActivityEvent(child.userId, {
    actorType: "agent",
    actorId: child.agentId ?? undefined,
    scopeType: child.taskId
      ? "task"
      : child.workspaceId
        ? "workspace"
        : child.agentId
          ? "agent"
          : "global",
    scopeId: child.taskId ?? child.workspaceId ?? child.agentId,
    eventType: "delegation.started",
    subjectType: "agent_run",
    subjectId: child.id,
    runId: child.id,
    parentRunId: parent.id,
    taskId: child.taskId ?? undefined,
    agentId: child.agentId ?? undefined,
    payload: {
      targetType:
        delegation.targetKind === "remote_agent" ? "remote_agent" : "agent",
    },
  });
}

async function recordRemoteEvent(
  child: AgentRun,
  eventType:
    | "agent.remote_task_created"
    | "agent.remote_status_changed"
    | "agent.remote_artifact_received"
    | "agent.remote_artifact_verified"
    | "agent.input_required"
    | "agent.auth_required",
  toStatus: string,
  payload: Record<string, unknown> = {},
) {
  await recordRuntimeActivityEvent(child.userId, {
    actorType: "agent",
    scopeType: child.taskId
      ? "task"
      : child.workspaceId
        ? "workspace"
        : "global",
    scopeId: child.taskId ?? child.workspaceId,
    eventType,
    subjectType: "agent_run",
    subjectId: child.id,
    runId: child.id,
    parentRunId: child.parentRunId ?? undefined,
    taskId: child.taskId ?? undefined,
    payload: { targetType: "remote_agent", toStatus, ...payload },
  });
}

async function recordTerminalEvent(child: AgentRun) {
  const status = child.status;
  if (!["succeeded", "failed", "cancelled", "timed_out"].includes(status))
    return;
  const eventType =
    status === "succeeded"
      ? "delegation.completed"
      : status === "cancelled"
        ? "delegation.cancelled"
        : status === "timed_out"
          ? "delegation.timed_out"
          : "delegation.failed";
  await recordRuntimeActivityEvent(child.userId, {
    actorType: "agent",
    actorId: child.agentId ?? undefined,
    scopeType: child.taskId
      ? "task"
      : child.workspaceId
        ? "workspace"
        : child.agentId
          ? "agent"
          : "global",
    scopeId: child.taskId ?? child.workspaceId ?? child.agentId,
    eventType,
    subjectType: "agent_run",
    subjectId: child.id,
    runId: child.id,
    parentRunId: child.parentRunId ?? undefined,
    taskId: child.taskId ?? undefined,
    agentId: child.agentId ?? undefined,
    payload: { targetType: "agent", errorCode: child.errorCode },
  });
  if (child.parentRunId) {
    const pending = await runManager.listPendingParentResumeIds(100);
    if (pending.includes(child.parentRunId)) {
      if (await enqueueParentResume(child.parentRunId))
        await runManager.markParentResumeDispatched(child.parentRunId);
    }
  }
}

export async function registerDelegationWorkers(boss: PgBoss) {
  await boss.createQueue(DELEGATION_EXECUTE_QUEUE);
  await boss.createQueue(DELEGATION_SWEEP_QUEUE);
  await boss.createQueue(DELEGATION_REMOTE_CANCEL_QUEUE);
  await boss.work<{ childRunId: string }>(
    DELEGATION_EXECUTE_QUEUE,
    { batchSize: DELEGATION_LIMITS.maxParallelChildren },
    async (jobs) => {
      for (const job of jobs) await execute(job.data.childRunId);
    },
  );
  await boss.work<{ childRunId: string }>(
    DELEGATION_REMOTE_CANCEL_QUEUE,
    async (jobs) => {
      for (const job of jobs) await execute.cancelRemote(job.data.childRunId);
    },
  );
  await boss.work(DELEGATION_SWEEP_QUEUE, async () => {
    const pending = await runManager.listPendingDispatchRunIds(100);
    for (const runId of pending) {
      if (await enqueueDelegatedRun(runId))
        await runManager.markDispatched(runId);
    }
    const stale = await runManager.listStaleDelegatedRunIds(
      new Date(Date.now() - DELEGATION_LIMITS.maxTimeoutMs),
      100,
    );
    for (const runId of stale) await enqueueDelegatedRun(runId);
    const cancellations =
      await runManager.listPendingRemoteCancellationRunIds(100);
    for (const runId of cancellations) {
      if (await enqueueRemoteCancellation(runId))
        await runManager.markRemoteCancellationDispatched(runId);
    }
  });
  await boss.schedule(DELEGATION_SWEEP_QUEUE, "*/5 * * * *", {});
}
