import type PgBoss from "pg-boss";
import type { CreateDurableJobInput } from "./contracts";

export const DURABLE_JOB_QUEUE = "durable-job";
export const DURABLE_JOB_SWEEP_QUEUE = "durable-job-sweep";
export const DURABLE_JOB_OUTBOX_QUEUE = "durable-job-completion-outbox";

export type DurableJobQueue = Pick<PgBoss, "createQueue" | "send">;

export async function enqueueDurableJobWakeup(
  boss: DurableJobQueue,
  jobId: string,
) {
  await boss.createQueue(DURABLE_JOB_QUEUE);
  return boss.send(
    DURABLE_JOB_QUEUE,
    { jobId },
    { singletonKey: jobId, retryLimit: 5, retryDelay: 30 },
  );
}

export async function createAndEnqueueDurableJob(
  service: {
    create(input: CreateDurableJobInput): Promise<{
      kind: "created" | "existing";
      job: { id: string; status: string };
    }>;
  },
  boss: DurableJobQueue,
  input: CreateDurableJobInput,
) {
  const result = await service.create(input);
  if (result.job.status === "queued") {
    await enqueueDurableJobWakeup(boss, result.job.id);
  }
  return result;
}
