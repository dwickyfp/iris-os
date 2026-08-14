import PgBoss from "pg-boss";
import type { ChatModel } from "app-types/chat";

export const MEMORY_EXTRACT_QUEUE = "memory-extract";
export const MEMORY_CURATE_QUEUE = "memory-curate";
export const MEMORY_SWEEP_QUEUE = "memory-sweep";
export const MEMORY_REEMBED_QUEUE = "memory-reembed";
export const MEMORY_REVIEW_QUEUE = MEMORY_EXTRACT_QUEUE;

export type MemoryReviewJob = {
  id: string;
  userId: string;
  threadId: string;
  assistantMessageId: string;
  userMessageId?: string;
  agentId?: string;
  userText: string;
  assistantText: string;
  chatModel?: ChatModel;
};

let boss: PgBoss | undefined;

function getBoss() {
  if (!process.env.POSTGRES_URL) return undefined;
  boss ??= new PgBoss({ connectionString: process.env.POSTGRES_URL });
  return boss;
}

export async function enqueueMemoryReview(job: MemoryReviewJob) {
  const queue = getBoss();
  if (!queue) return;
  await queue.start();
  await queue.createQueue(MEMORY_EXTRACT_QUEUE);
  await queue.send(MEMORY_EXTRACT_QUEUE, job, {
    singletonKey: `${job.threadId}:${job.assistantMessageId}`,
    retryLimit: 3,
    retryDelay: 30,
    // pg-boss requires this to be strictly below its 24-hour policy limit.
    expireInHours: 23,
  });
}
