import "load-env";
import PgBoss from "pg-boss";
import { embed, generateObject } from "ai";
import { z } from "zod";
import type { MemoryScope } from "app-types/memory";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  customModelProvider,
  getCuratorModelConfiguration,
} from "lib/ai/models";
import { memoryContentHash } from "lib/ai/memory/curator";
import { runMemoryReviewAgent } from "lib/ai/memory/review-agent";
import { getMemoryCuratorMode } from "lib/ai/memory/reviewer";
import { resolveOwnedMemoryScope } from "lib/ai/memory/scope-server";
import {
  isSafeMemoryContent,
  sanitizeMemoryContent,
} from "lib/ai/memory/guardrails";
import {
  MEMORY_CURATE_QUEUE,
  MEMORY_CONSOLIDATE_QUEUE,
  MEMORY_EXTRACT_QUEUE,
  MEMORY_REEMBED_QUEUE,
  MEMORY_REVIEW_QUEUE,
  MEMORY_SWEEP_QUEUE,
  type LegacyMemoryReviewJob,
  type MemoryConsolidationJob,
  type MemoryReviewJob,
} from "lib/ai/memory/queue";
import { pgDb } from "lib/db/pg/db.pg";
import {
  MemoryCuratorRunTable,
  MemoryEmbeddingTable,
  UserMemoryTable,
} from "lib/db/pg/schema.pg";
import {
  chatRepository,
  memoryGraphRepository,
  memoryReviewRepository,
} from "lib/db/repository";
import { generateUUID } from "lib/utils";
import { getLearningSettings } from "lib/learning/settings";
import { isV2FeatureEnabled } from "lib/feature-flags";

const CandidateSchema = z.object({
  kind: z.enum([
    "identity",
    "preference",
    "semantic",
    "episodic",
    "decision",
    "procedure",
    "operational",
    "relationship",
    "goal",
  ]),
  content: z.string().min(1).max(2_000),
  confidence: z.number().min(0).max(1),
});
const ReviewSchema = z.object({ candidates: z.array(CandidateSchema).max(5) });
type Candidate = z.infer<typeof CandidateSchema>;
type CurateJob = {
  id: string;
  userId: string;
  threadId: string;
  workspaceId?: string;
  messageId?: string;
  candidate: Candidate;
};

async function isMemoryLearningAllowed(
  userId: string,
  scopeType: MemoryScope["scopeType"],
) {
  if (!isV2FeatureEnabled("learning")) return true;
  const settings = await getLearningSettings(userId);
  return (
    settings.enabled &&
    settings.allowedCategories.includes("memory") &&
    settings.allowedScopes.includes(scopeType)
  );
}

async function startRun(
  userId: string,
  jobType:
    | "extract"
    | "curate"
    | "sweep"
    | "reembed"
    | "review"
    | "consolidate",
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
  if (existing.status === "completed") return { id: existing.id, completed: true };
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

async function extract(job: LegacyMemoryReviewJob, boss: PgBoss) {
  const { id: runId } = await startRun(job.userId, "extract");
  try {
    const scopeType = job.workspaceId ? "workspace" : "global";
    if (!(await isMemoryLearningAllowed(job.userId, scopeType))) {
      await completeRun(runId, { skippedByPolicy: 1 });
      return;
    }
    const { object } = await generateObject({
      model: await customModelProvider.getCuratorModel(),
      schema: ReviewSchema,
      instructions:
        "Legacy queue drain only. Extract durable explicit atomic facts stated by the user. Never save questions, hypotheticals, quoted content, third-party facts, temporary state, sensitive data, or uncertain implications. Return no candidate when uncertain.",
      prompt: `User message:\n${job.userText}\n\nAssistant response (context only):\n${job.assistantText}`,
    });
    let candidates = object.candidates;
    candidates = candidates
      .map((candidate) => ({
        ...candidate,
        content: sanitizeMemoryContent(candidate.content),
      }))
      .filter((candidate) => isSafeMemoryContent(candidate.content));
    for (const candidate of candidates) {
      const curateJob: CurateJob = {
        id: `${job.id}:${candidate.content}`,
        userId: job.userId,
        threadId: job.threadId,
        workspaceId: job.workspaceId,
        messageId: job.userMessageId,
        candidate,
      };
      await boss.send(MEMORY_CURATE_QUEUE, curateJob, {
        singletonKey: curateJob.id,
        retryLimit: 5,
        retryDelay: 30,
        expireInHours: 23,
      });
    }
    await completeRun(runId, { extracted: candidates.length });
  } catch (error) {
    await completeRun(runId, {}, error);
    throw error;
  }
}

async function curate(job: CurateJob) {
  const scope = await resolveOwnedMemoryScope(job.userId, {
    scopeType: job.workspaceId ? "workspace" : "global",
    scopeId: job.workspaceId,
  });
  const { id: runId } = await startRun(job.userId, "curate", scope);
  try {
    if (!(await isMemoryLearningAllowed(job.userId, scope.scopeType))) {
      await completeRun(runId, { skippedByPolicy: 1 });
      return;
    }
    const result = await memoryGraphRepository.curateClaim({
      ...job.candidate,
      userId: job.userId,
      provenance: "background_review",
      threadId: job.threadId,
      messageId: job.messageId,
      scope,
    });
    await embedNode(job.userId, result.memoryId, job.candidate.content, scope);
    await memoryGraphRepository.sweep(job.userId, scope);
    await completeRun(runId, { [result.action]: 1 });
  } catch (error) {
    await completeRun(runId, {}, error);
    throw error;
  }
}

function messageText(message: { parts: unknown }) {
  if (!Array.isArray(message.parts)) return "";
  return message.parts
    .filter(
      (part): part is { type: string; text: string } =>
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
      const memories = await pgDb
        .select()
        .from(UserMemoryTable)
        .where(
          and(
            eq(UserMemoryTable.userId, job.userId),
            inArray(UserMemoryTable.id, memoryIds),
            eq(UserMemoryTable.status, "active"),
          ),
        );
      for (const memory of memories)
        await embedNode(job.userId, memory.id, memory.content, {
          scopeType: memory.scopeType,
          scopeId: memory.scopeId,
        });
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
    if (await pgDb
      .select({ status: MemoryCuratorRunTable.status })
      .from(MemoryCuratorRunTable)
      .where(eq(MemoryCuratorRunTable.id, runId))
      .limit(1)
      .then(([run]) => commitSucceeded && run?.status === "completed")) {
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
        agentId: scope.scopeType === "agent" ? scope.scopeId ?? undefined : undefined,
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

async function embedNode(
  userId: string,
  nodeId: string,
  content: string,
  scope: MemoryScope,
) {
  try {
    const configured = await customModelProvider.getEmbeddingModel();
    if (!configured) return false;
    const result = await embed({ model: configured.model, value: content });
    const dimensions = result.embedding.length;
    const [row] = await pgDb
      .insert(MemoryEmbeddingTable)
      .values({
        id: generateUUID(),
        userId,
        ...scope,
        nodeId,
        nodeType: "claim",
        model: configured.modelId,
        dimensions,
        values: result.embedding,
        contentHash: memoryContentHash(content),
      })
      .onConflictDoUpdate({
        target: [
          MemoryEmbeddingTable.userId,
          MemoryEmbeddingTable.scopeType,
          MemoryEmbeddingTable.scopeId,
          MemoryEmbeddingTable.nodeId,
          MemoryEmbeddingTable.model,
        ],
        set: {
          dimensions,
          values: result.embedding,
          contentHash: memoryContentHash(content),
          updatedAt: new Date(),
        },
      })
      .returning({ id: MemoryEmbeddingTable.id });
    try {
      const vector = `[${result.embedding.join(",")}]`;
      await pgDb.execute(
        sql`UPDATE memory_embedding SET vector_value = ${vector}::vector WHERE id = ${row.id} AND user_id = ${userId}`,
      );
    } catch {
      // JSON remains available when the vector extension is unavailable.
    }
    return true;
  } catch (error) {
    console.warn(
      `Memory embedding failed; lexical retrieval remains active: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

async function reembedAll() {
  const claims = await pgDb
    .select({
      id: UserMemoryTable.id,
      userId: UserMemoryTable.userId,
      content: UserMemoryTable.content,
      scopeType: UserMemoryTable.scopeType,
      scopeId: UserMemoryTable.scopeId,
    })
    .from(UserMemoryTable)
    .where(
      and(
        eq(UserMemoryTable.status, "active"),
        isNull(UserMemoryTable.deletedAt),
      ),
    );
  for (const claim of claims)
    await embedNode(claim.userId, claim.id, claim.content, {
      scopeType: claim.scopeType,
      scopeId: claim.scopeId,
    });
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

if (!process.env.POSTGRES_URL)
  throw new Error("POSTGRES_URL is required for the memory worker");
const boss = new PgBoss({ connectionString: process.env.POSTGRES_URL });
await boss.start();
for (const queue of [
  MEMORY_EXTRACT_QUEUE,
  MEMORY_CURATE_QUEUE,
  MEMORY_CONSOLIDATE_QUEUE,
  MEMORY_REVIEW_QUEUE,
  MEMORY_SWEEP_QUEUE,
  MEMORY_REEMBED_QUEUE,
])
  await boss.createQueue(queue);
await boss.schedule(
  MEMORY_SWEEP_QUEUE,
  "30 19 * * *",
  { global: true },
  { tz: "UTC" },
);
await boss.work<LegacyMemoryReviewJob>(
  MEMORY_EXTRACT_QUEUE,
  { batchSize: 2 },
  async (jobs) => {
    for (const job of jobs) await extract(job.data, boss);
  },
);
await boss.work<MemoryReviewJob>(
  MEMORY_REVIEW_QUEUE,
  { batchSize: 2 },
  async (jobs) => {
    for (const job of jobs) await review(job.data);
  },
);
await boss.work<MemoryConsolidationJob>(
  MEMORY_CONSOLIDATE_QUEUE,
  { batchSize: 1 },
  async (jobs) => {
    for (const job of jobs) await consolidate(job.data);
  },
);
await boss.work<CurateJob>(
  MEMORY_CURATE_QUEUE,
  { batchSize: 4 },
  async (jobs) => {
    for (const job of jobs) await curate(job.data);
  },
);
await boss.work(MEMORY_SWEEP_QUEUE, async () => sweepAll());
await boss.work(MEMORY_REEMBED_QUEUE, async () => reembedAll());
console.info(
  "Memory graph worker started (agentic review, legacy drain, sweep, reembed)",
);
