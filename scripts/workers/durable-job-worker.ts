import type { RunInbox } from "lib/jobs/contracts";
import {
  DURABLE_JOB_OUTBOX_QUEUE,
  DURABLE_JOB_QUEUE,
  DURABLE_JOB_SWEEP_QUEUE,
} from "lib/jobs/queue";
import type { DurableJobPgRepository } from "lib/jobs/repository.pg";
import { pgDurableJobRepository } from "lib/jobs/repository.pg";
import { serverRunInbox } from "lib/jobs/server";
import {
  DurableJobTargetRegistry,
  CAPABILITY_ORCHESTRATION_JOB_TYPE,
} from "lib/jobs/targets";
import { productionCapabilityOrchestrationTarget } from "lib/jobs/orchestration-target.server";
import type PgBoss from "pg-boss";

const LEASE_MS = 60_000;
const OUTBOX_LEASE_MS = 30_000;

export type DurableJobWorkerDependencies = {
  repository: DurableJobPgRepository;
  targets: DurableJobTargetRegistry;
  runInbox: RunInbox;
  leaseMs?: number;
};

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown) {
  const value = message(error);
  if (value.includes("POLICY_DENIED")) return "POLICY_DENIED";
  if (value.includes("APPROVAL_REQUIRED")) return "APPROVAL_REQUIRED";
  if (value.includes("STALE_GOAL_REVISION")) return "STALE_GOAL_REVISION";
  if (value.includes("CAPABILITY_NOT_AUTHORIZED")) return "NOT_AUTHORIZED";
  if (value.includes("DURABLE_JOB_RUN_NOT_EXECUTABLE"))
    return "RUN_NOT_EXECUTABLE";
  if (value.includes("DURABLE_JOB_POLICY_SNAPSHOT_REQUIRED"))
    return "POLICY_SNAPSHOT_REQUIRED";
  if (value.startsWith("DURABLE_JOB_TARGET_")) return "TARGET_REJECTED";
  if (value.startsWith("DURABLE_JOB_PAYLOAD_")) return "PAYLOAD_REJECTED";
  if (
    error instanceof Error &&
    (error.name === "ZodError" ||
      error.name === "OrchestrationPlanDependencyError")
  )
    return "PLAN_INVALID";
  if (error instanceof Error && error.name === "BudgetExhaustedError")
    return "BUDGET_EXHAUSTED";
  return "DURABLE_JOB_FAILED";
}

export function createDurableJobWorker(
  workerId: string,
  dependencies: DurableJobWorkerDependencies,
) {
  const leaseMs = dependencies.leaseMs ?? LEASE_MS;

  async function executeOne() {
    const lease = await dependencies.repository.claim({
      workerId,
      leaseDurationMs: leaseMs,
    });
    if (!lease) return false;
    const controller = new AbortController();
    let leaseActive = true;
    const heartbeat = setInterval(
      () => {
        void dependencies.repository
          .heartbeat({
            jobId: lease.job.id,
            leaseToken: lease.token,
            leaseDurationMs: leaseMs,
          })
          .then((result) => {
            if (result.kind !== "active") {
              leaseActive = false;
              controller.abort(new Error("LEASE_LOST"));
            }
          })
          .catch((error) =>
            console.error("durable job heartbeat failed", lease.job.id, error),
          );
      },
      Math.max(1_000, Math.floor(leaseMs / 3)),
    );
    heartbeat.unref();
    try {
      const outcome = await dependencies.targets.execute(lease.job, {
        signal: controller.signal,
      });
      const finished = await dependencies.repository.finish({
        jobId: lease.job.id,
        leaseToken: lease.token,
        outcome,
      });
      if (!finished) {
        leaseActive = false;
        controller.abort(new Error("LEASE_LOST"));
        throw new Error("DURABLE_JOB_LEASE_LOST");
      }
    } catch (error) {
      // Capability orchestration is at-most-once. A failed execution must not
      // replay side effects that may already have completed.
      if (leaseActive && !controller.signal.aborted)
        await dependencies.repository.finish({
          jobId: lease.job.id,
          leaseToken: lease.token,
          outcome: {
            status: "failed",
            error: message(error),
            errorCode: errorCode(error),
          },
        });
      else throw error;
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  async function drainJobs(limit = 10) {
    for (let index = 0; index < limit; index++) {
      if (!(await executeOne())) break;
    }
  }

  async function publishOne() {
    const outbox = await dependencies.repository.claimCompletionOutbox({
      leaseDurationMs: OUTBOX_LEASE_MS,
    });
    if (!outbox) return false;
    try {
      await dependencies.runInbox.injectCompletion(outbox.completion);
      await dependencies.repository.completeCompletionOutbox(outbox);
    } catch (error) {
      await dependencies.repository.retryCompletionOutbox({
        id: outbox.id,
        leaseToken: outbox.leaseToken,
        error: message(error),
        delayMs: Math.min(300_000, 1_000 * 2 ** 4),
      });
    }
    return true;
  }

  async function drainOutbox(limit = 20) {
    for (let index = 0; index < limit; index++) {
      if (!(await publishOne())) break;
    }
  }

  return { drainJobs, drainOutbox, executeOne, publishOne };
}

export async function registerDurableJobWorkers(
  boss: PgBoss,
  workerId: string,
  dependencies: DurableJobWorkerDependencies = {
    repository: pgDurableJobRepository,
    targets: new DurableJobTargetRegistry().register(
      CAPABILITY_ORCHESTRATION_JOB_TYPE,
      productionCapabilityOrchestrationTarget,
    ),
    runInbox: serverRunInbox,
  },
) {
  const worker = createDurableJobWorker(workerId, dependencies);
  await boss.createQueue(DURABLE_JOB_QUEUE);
  await boss.createQueue(DURABLE_JOB_SWEEP_QUEUE);
  await boss.createQueue(DURABLE_JOB_OUTBOX_QUEUE);
  await boss.work(DURABLE_JOB_QUEUE, async () => worker.drainJobs());
  await boss.work(DURABLE_JOB_SWEEP_QUEUE, async () => worker.drainJobs());
  await boss.work(DURABLE_JOB_OUTBOX_QUEUE, async () => worker.drainOutbox());
  await boss.schedule(DURABLE_JOB_SWEEP_QUEUE, "*/1 * * * *", {});
  await boss.schedule(DURABLE_JOB_OUTBOX_QUEUE, "*/1 * * * *", {});
}
