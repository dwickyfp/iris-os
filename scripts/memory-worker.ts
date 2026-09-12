import "load-env";
import type { MemoryScope } from "app-types/memory";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  MEMORY_CONSOLIDATE_QUEUE,
  MEMORY_REVIEW_QUEUE,
  MEMORY_SWEEP_QUEUE,
  type MemoryConsolidationJob,
  type MemoryReviewJob,
} from "lib/ai/memory/queue";
import { runMemoryReviewAgent } from "lib/ai/memory/review-agent";
import { getMemoryCuratorMode } from "lib/ai/memory/reviewer";
import { resolveOwnedMemoryScope } from "lib/ai/memory/scope-server";
import {
  customModelProvider,
  getCuratorModelConfiguration,
} from "lib/ai/models";
import { pgDb } from "lib/db/pg/db.pg";
import { MemoryCuratorRunTable, UserMemoryTable } from "lib/db/pg/schema.pg";
import {
  chatRepository,
  memoryGraphRepository,
  memoryReviewRepository,
} from "lib/db/repository";
import { getStartedPgBoss } from "lib/jobs/pg-boss";
import { getLearningSettings } from "lib/learning/settings";
import { startRuntimeSystemSettingsRefresh } from "lib/system-settings/runtime";
import { generateUUID } from "lib/utils";

async function startRun(
  userId: string,
  jobType: "extract" | "curate" | "sweep" | "review" | "consolidate",
  scope: MemoryScope = {
    scopeType: "global",
    scopeId: null,
  },
  jobKey?: string,
) {
  const [run] = await pgDb
    .insert(MemoryCuratorRunTable)
    .values({
      id: generateUUID(),
      userId,
      ...scope,
      jobKey,
      jobType,
      status: "running",
      stats: {},
    })
    .onConflictDoNothing()
    .returning();
  if (run) return { id: run.id, completed: false };
  if (!jobKey) throw new Error("Unable to start memory curator run");
  const [existing] = await pgDb
    .select()
    .from(MemoryCuratorRunTable)
    .where(eq(MemoryCuratorRunTable.jobKey, jobKey))
    .limit(1);
  if (!existing) throw new Error("Unable to resume memory curator run");
  if (existing.status === "completed")
    return { id: existing.id, completed: true };
  await pgDb
    .update(MemoryCuratorRunTable)
    .set({ status: "running", error: null, completedAt: null })
    .where(eq(MemoryCuratorRunTable.id, existing.id));
  return { id: existing.id, completed: false };
}

async function completeRun(
  id: string,
  stats: Record<string, number>,
  error?: unknown,
  rollbackSnapshot?: unknown,
) {
  await pgDb
    .update(MemoryCuratorRunTable)
    .set({
      status: error ? "failed" : "completed",
      stats,
      rollbackSnapshot,
      error:
        error instanceof Error
          ? error.message.slice(0, 2_000)
          : error
            ? String(error).slice(0, 2_000)
            : null,
      completedAt: new Date(),
    })
    .where(eq(MemoryCuratorRunTable.id, id));
}

function messageText(message: { parts: unknown }) {
  if (!Array.isArray(message.parts)) return "";
  return message.parts
    .filter((part): part is { type: string; text: string } =>
      Boolean(
        part &&
          typeof part === "object" &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string",
      ),
    )
    .map((part) => part.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8_000);
}

async function loadReviewContext(job: MemoryReviewJob) {
  const thread = await chatRepository.selectThreadDetails(job.threadId);
  if (!thread || thread.userId !== job.userId)
    throw new Error("Memory review thread is unavailable");
  if ((thread.workspaceId ?? undefined) !== job.workspaceId)
    throw new Error("Memory review workspace changed");
  if ((thread.taskId ?? undefined) !== job.taskId)
    throw new Error("Memory review task changed");
  const assistantIndex = thread.messages.findIndex(
    (message) => message.id === job.assistantMessageId,
  );
  if (assistantIndex < 0)
    throw new Error("Memory review assistant message is unavailable");
  const currentUser = thread.messages.find(
    (message) => message.id === job.userMessageId && message.role === "user",
  );
  if (!currentUser)
    throw new Error("Memory review user message is unavailable");
  const transcript = thread.messages
    .slice(Math.max(0, assistantIndex - 11), assistantIndex + 1)
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: messageText(message),
    }))
    .filter((message) => message.content);
  return {
    transcript,
    currentUserText: messageText(currentUser),
  };
}

async function availableReviewScopes(job: MemoryReviewJob) {
  const inputs: Array<{
    scopeType: MemoryScope["scopeType"];
    scopeId?: string;
  }> = [{ scopeType: "global" }];
  if (job.workspaceId)
    inputs.push({ scopeType: "workspace", scopeId: job.workspaceId });
  if (job.taskId) inputs.push({ scopeType: "task", scopeId: job.taskId });
  if (job.agentId) inputs.push({ scopeType: "agent", scopeId: job.agentId });
  const scopes: MemoryScope[] = [];
  for (const input of inputs)
    scopes.push(await resolveOwnedMemoryScope(job.userId, input));
  return scopes;
}

async function review(
  job: MemoryReviewJob,
  options: {
    jobType?: "review" | "consolidate";
    mode?: "shadow" | "write";
    scopes?: MemoryScope[];
    focus?: string;
  } = {},
) {
  const scopes = options.scopes ?? (await availableReviewScopes(job));
  const runScope =
    scopes.find((scope) => scope.scopeType === "task") ??
    scopes.find((scope) => scope.scopeType === "workspace") ??
    scopes.find((scope) => scope.scopeType === "agent") ??
    scopes[0];
  const run = await startRun(
    job.userId,
    options.jobType ?? "review",
    runScope,
    `memory-${options.jobType ?? "review"}:${job.id}`,
  );
  if (run.completed) return;
  const runId = run.id;
  let commitSucceeded = false;
  try {
    const mode = options.mode ?? getMemoryCuratorMode();
    if (mode === "off") {
      await completeRun(runId, { skippedByMode: 1 });
      return;
    }
    const settings = await getLearningSettings(job.userId);
    if (!settings.enabled || !settings.allowedCategories.includes("memory")) {
      await completeRun(runId, { skippedByPolicy: 1 });
      return;
    }
    const allowedScopes = scopes.filter((scope) =>
      settings.allowedScopes.includes(scope.scopeType),
    );
    if (!allowedScopes.length) {
      await completeRun(runId, { skippedByPolicy: 1 });
      return;
    }
    const modelConfig = await getCuratorModelConfiguration();
    if (!modelConfig?.capabilities.toolCalls)
      throw new Error("No tool-capable curator model is configured");
    const context = await loadReviewContext(job);
    if (!context.currentUserText) {
      await completeRun(runId, { ignored: 1 });
      return;
    }
    const allowedTargetIds = new Set<string>();
    let commitStats: Record<string, number> = {};
    let memoryIds: string[] = [];
    const result = await runMemoryReviewAgent({
      transcript: context.transcript,
      scopes: allowedScopes,
      mode,
      focus: options.focus,
      dependencies: {
        model: await customModelProvider.getCuratorModel(),
        search: async (query) => {
          const candidates = await memoryReviewRepository.findCandidates({
            userId: job.userId,
            query,
            scopes: allowedScopes,
          });
          candidates.forEach((candidate) => allowedTargetIds.add(candidate.id));
          return candidates;
        },
        commit: async (batch) => {
          const committed = await memoryReviewRepository.commitOperations({
            runId,
            userId: job.userId,
            threadId: job.threadId,
            messageId: job.userMessageId,
            userText: context.currentUserText,
            scopes: allowedScopes,
            allowedScopeTypes: settings.allowedScopes,
            allowedTargetIds,
            batch,
            mode,
            consolidation: options.jobType === "consolidate",
          });
          commitStats = committed.stats;
          memoryIds = committed.memoryIds;
          commitSucceeded = true;
          return committed;
        },
      },
    });
    if (memoryIds.length) {
      for (const scope of allowedScopes)
        await memoryGraphRepository.sweep(job.userId, scope);
    }
    await completeRun(
      runId,
      { ...result.stats, ...commitStats },
      undefined,
      result.proposal,
    );
  } catch (error) {
    if (
      await pgDb
        .select({ status: MemoryCuratorRunTable.status })
        .from(MemoryCuratorRunTable)
        .where(eq(MemoryCuratorRunTable.id, runId))
        .limit(1)
        .then(([run]) => commitSucceeded && run?.status === "completed")
    ) {
      console.warn(
        `Memory review agent ended after a committed batch: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    await completeRun(runId, {}, error);
    throw error;
  }
}

async function consolidate(job: MemoryConsolidationJob) {
  const scope = await resolveOwnedMemoryScope(job.userId, {
    scopeType: job.scopeType,
    scopeId: job.scopeId,
  });
  const memories = await pgDb
    .select({
      id: UserMemoryTable.id,
      threadId: UserMemoryTable.sourceThreadId,
      messageId: UserMemoryTable.sourceMessageId,
    })
    .from(UserMemoryTable)
    .where(
      and(
        eq(UserMemoryTable.userId, job.userId),
        eq(UserMemoryTable.scopeType, scope.scopeType),
        scope.scopeId === null
          ? isNull(UserMemoryTable.scopeId)
          : eq(UserMemoryTable.scopeId, scope.scopeId),
        eq(UserMemoryTable.status, "active"),
        isNull(UserMemoryTable.deletedAt),
        isNotNull(UserMemoryTable.sourceThreadId),
        isNotNull(UserMemoryTable.sourceMessageId),
      ),
    )
    .limit(500);
  const sources = [
    ...new Map(
      memories.map((memory) => [
        `${memory.threadId}:${memory.messageId}`,
        memory,
      ]),
    ).values(),
  ];
  for (const source of sources) {
    if (!source.threadId || !source.messageId) continue;
    const thread = await chatRepository.selectThreadDetails(source.threadId);
    if (!thread || thread.userId !== job.userId) continue;
    const userIndex = thread.messages.findIndex(
      (message) => message.id === source.messageId && message.role === "user",
    );
    const assistant = thread.messages
      .slice(userIndex + 1)
      .find((message) => message.role === "assistant");
    if (userIndex < 0 || !assistant) continue;
    await review(
      {
        id: `${job.id}:${source.messageId}`,
        userId: job.userId,
        threadId: source.threadId,
        userMessageId: source.messageId,
        assistantMessageId: assistant.id,
        workspaceId: thread.workspaceId ?? undefined,
        taskId: thread.taskId ?? undefined,
        agentId:
          scope.scopeType === "agent"
            ? (scope.scopeId ?? undefined)
            : undefined,
      },
      {
        jobType: "consolidate",
        mode: job.mode,
        scopes: [scope],
        focus:
          "This is a historical consolidation replay. Do not infer any new fact or change polarity. You may supersede an existing compound or duplicate claim with explicitCurrentCorrection=false only to losslessly preserve every durable atomic fact contained in the quoted historical user message. Prefer ignore when lossless atomization is uncertain.",
      },
    );
  }
  await memoryGraphRepository.sweep(job.userId, scope);
}

async function sweepAll() {
  const users = await pgDb
    .selectDistinct({
      userId: UserMemoryTable.userId,
      scopeType: UserMemoryTable.scopeType,
      scopeId: UserMemoryTable.scopeId,
    })
    .from(UserMemoryTable);
  for (const { userId, scopeType, scopeId } of users) {
    const scope = { scopeType, scopeId };
    const { id: runId } = await startRun(userId, "sweep", scope);
    try {
      await memoryGraphRepository.sweep(userId, scope);
      await completeRun(runId, { topicsUpdated: 1 });
    } catch (error) {
      await completeRun(runId, {}, error);
    }
  }
}

await startRuntimeSystemSettingsRefresh();
if (!process.env.POSTGRES_URL)
  throw new Error("POSTGRES_URL is required for the memory worker");
const boss = await getStartedPgBoss();
if (!boss) throw new Error("POSTGRES_URL is required for the memory worker");
for (const queue of [
  MEMORY_CONSOLIDATE_QUEUE,
  MEMORY_REVIEW_QUEUE,
  MEMORY_SWEEP_QUEUE,
])
  await boss.createQueue(queue);
await boss.schedule(
  MEMORY_SWEEP_QUEUE,
  "30 19 * * *",
  { global: true },
  { tz: "UTC" },
);
await boss.work<MemoryReviewJob>(
  MEMORY_REVIEW_QUEUE,
  { batchSize: 2 },
  async (jobs) => {
    await Promise.all(jobs.map((job) => review(job.data)));
  },
);
await boss.work<MemoryConsolidationJob>(
  MEMORY_CONSOLIDATE_QUEUE,
  { batchSize: 1 },
  async (jobs) => {
    for (const job of jobs) await consolidate(job.data);
  },
);
await boss.work(MEMORY_SWEEP_QUEUE, async () => sweepAll());
console.info(
  "Memory graph worker started (agentic review, consolidate, sweep)",
);
