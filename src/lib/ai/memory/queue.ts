import PgBoss from "pg-boss";
import type { ChatModel } from "app-types/chat";
import type { MemoryScopeType } from "app-types/memory";

export const MEMORY_EXTRACT_QUEUE = "memory-extract";
export const MEMORY_CURATE_QUEUE = "memory-curate";
export const MEMORY_SWEEP_QUEUE = "memory-sweep";
export const MEMORY_REEMBED_QUEUE = "memory-reembed";
export const MEMORY_REVIEW_QUEUE = "memory-review-v2";
export const MEMORY_CONSOLIDATE_QUEUE = "memory-consolidate-v2";

export type MemoryReviewJob = {
  id: string;
  userId: string;
  threadId: string;
  assistantMessageId: string;
  userMessageId: string;
  workspaceId?: string;
  taskId?: string;
  agentId?: string;
};

export type LegacyMemoryReviewJob = {
  id: string;
  userId: string;
  threadId: string;
  workspaceId?: string;
  assistantMessageId: string;
  userMessageId?: string;
  agentId?: string;
  userText: string;
  assistantText: string;
  chatModel?: ChatModel;
};

export type MemoryConsolidationJob = {
  id: string;
  userId: string;
  scopeType: MemoryScopeType;
  scopeId?: string;
  mode: "shadow" | "write";
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

export async function enqueueMemoryConsolidation(job: MemoryConsolidationJob) {
  const queue = getBoss();
  if (!queue) throw new Error("POSTGRES_URL is required");
  await queue.start();
  await queue.createQueue(MEMORY_CONSOLIDATE_QUEUE);
  await queue.send(MEMORY_CONSOLIDATE_QUEUE, job, {
    singletonKey: job.id,
    retryLimit: 2,
    retryDelay: 60,
    expireInHours: 23,
  });
}
