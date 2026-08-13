import PgBoss from "pg-boss";
import type { ChatModel } from "app-types/chat";

export const MEMORY_REVIEW_QUEUE = "memory-review";

export type MemoryReviewJob = {
  id: string;
  userId: string;
  threadId: string;
  assistantMessageId: string;
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
  await queue.createQueue(MEMORY_REVIEW_QUEUE);
  await queue.send(MEMORY_REVIEW_QUEUE, job, {
    singletonKey: `${job.threadId}:${job.assistantMessageId}`,
    retryLimit: 3,
    retryDelay: 30,
    // pg-boss requires this to be strictly below its 24-hour policy limit.
    expireInHours: 23,
  });
}
