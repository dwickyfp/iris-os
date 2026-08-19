import { embed } from "ai";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { MemoryKind, MemoryScope } from "app-types/memory";
import {
  MEMORY_TOPIC_LABELS,
  type MemoryCuratorMode,
  type MemoryOperation,
  type MemoryOperationBatch,
  type MemorySearchCandidate,
  type MemoryTopicKey,
} from "lib/ai/memory/reviewer";
import {
  isSafeMemoryContent,
  sanitizeMemoryContent,
} from "lib/ai/memory/guardrails";
import { memoryContentHash, normalizeMemoryText } from "lib/ai/memory/curator";
import { memoryScopeKey } from "lib/ai/memory/scope";
import { getMemoryRecallMode } from "lib/ai/memory/reviewer";
import { generateUUID } from "lib/utils";
import { pgDb as db } from "../db.pg";
import {
  MemoryEdgeTable,
  MemoryCuratorRunTable,
  MemoryEntityTable,
  MemoryEvidenceTable,
  MemoryTopicTable,
  UserMemoryEventTable,
  UserMemoryTable,
} from "../schema.pg";

type MemoryRow = typeof UserMemoryTable.$inferSelect;

const LEXICAL_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "aku",
  "saya",
  "kamu",
  "dan",
  "yang",
  "dengan",
  "untuk",
  "tidak",
  "sudah",
]);

function lexicalTerms(query: string) {
  return normalizeMemoryText(query)
    .split(" ")
    .filter((term) => term.length > 2 && !LEXICAL_STOPWORDS.has(term))
    .slice(0, 10);
}

/** websearch_to_tsquery treats spaces as AND, so lexical recall joins terms with OR. */
function lexicalTsQuery(terms: string[]) {
  return terms.join(" OR ");
}

function contentMatchesTerms(terms: string[]) {
  return terms.length
    ? sql`${UserMemoryTable.content} @@ websearch_to_tsquery('simple', ${lexicalTsQuery(terms)})`
    : undefined;
}

function contentRank(terms: string[]) {
  return sql`ts_rank(to_tsvector('simple', ${UserMemoryTable.content}), websearch_to_tsquery('simple', ${lexicalTsQuery(terms)}))`;
}

function exactScope(
  table: { scopeType: any; scopeId: any },
  scope: MemoryScope,
) {
  return and(
    eq(table.scopeType, scope.scopeType),
    scope.scopeId === null
      ? isNull(table.scopeId)
      : eq(table.scopeId, scope.scopeId),
  );
}

function confidence(value: number) {
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

function toCandidate(row: MemoryRow): MemorySearchCandidate {
  return {
    id: row.id,
    kind: row.kind,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    content: row.content,
    confidence: row.confidence / 100,
    frequency: row.frequency,
    status: row.status as "active" | "pending",
    updatedAt: row.updatedAt,
  };
}

async function semanticCandidateIds(
  userId: string,
  query: string,
  scopes: MemoryScope[],
  limit: number,
) {
  if (getMemoryRecallMode() === "keyword") return [];
  try {
    const { customModelProvider } = await import("lib/ai/models");
    const configured = await customModelProvider.getEmbeddingModel();
    if (!configured) return [];
    const result = await embed({ model: configured.model, value: query });
    const vector = `[${result.embedding.join(",")}]`;
    const ids: string[] = [];
    for (const scope of scopes) {
      const rows = await db.execute<{ node_id: string }>(
        sql`SELECT node_id FROM memory_embedding WHERE user_id = ${userId} AND scope_type = ${scope.scopeType} AND scope_id IS NOT DISTINCT FROM ${scope.scopeId} AND node_type = 'claim' AND model = ${configured.modelId} AND vector_value IS NOT NULL ORDER BY vector_value <=> ${vector}::vector LIMIT ${limit}`,
      );
      ids.push(...rows.rows.map((row) => row.node_id));
    }
    return [...new Set(ids)].slice(0, limit);
  } catch {
    return [];
  }
}

async function findCandidates(input: {
  userId: string;
  query: string;
  scopes: MemoryScope[];
  limit?: number;
}) {
  const limit = Math.min(12, Math.max(1, input.limit ?? 12));
  const terms = lexicalTerms(input.query);
  const lexical: MemoryRow[] = [];
  for (const scope of input.scopes) {
    const rows = await db
      .select()
      .from(UserMemoryTable)
      .where(
        and(
          eq(UserMemoryTable.userId, input.userId),
          exactScope(UserMemoryTable, scope),
          inArray(UserMemoryTable.status, ["active", "pending"]),
          isNull(UserMemoryTable.deletedAt),
          contentMatchesTerms(terms),
        ),
      )
      .orderBy(
        ...(terms.length ? [sql`${contentRank(terms)} DESC`] : []),
        desc(UserMemoryTable.updatedAt),
      )
      .limit(limit);
    lexical.push(...rows);
  }
  const semanticIds = await semanticCandidateIds(
    input.userId,
    input.query,
    input.scopes,
    limit,
  );
  const semantic = semanticIds.length
    ? await db
        .select()
        .from(UserMemoryTable)
        .where(
          and(
            eq(UserMemoryTable.userId, input.userId),
            inArray(UserMemoryTable.id, semanticIds),
            inArray(UserMemoryTable.status, ["active", "pending"]),
            isNull(UserMemoryTable.deletedAt),
          ),
        )
    : [];
  return [
    ...new Map(
      [...lexical, ...semantic].map((row) => [row.id, toCandidate(row)]),
    ).values(),
  ].slice(0, limit);
}

function scopeForType(
  scopes: MemoryScope[],
  scopeType: MemoryScope["scopeType"],
) {
  const scope = scopes.find((candidate) => candidate.scopeType === scopeType);
  if (!scope) throw new Error(`Memory scope ${scopeType} is unavailable`);
  return scope;
}

function validateEvidence(userText: string, quote: string) {
  const evidence = quote.trim();
  if (!evidence || !userText.includes(evidence))
    throw new Error(
      "Memory evidence must quote the current user message exactly",
    );
  return evidence;
}

function validateContent(content: string) {
  const sanitized = sanitizeMemoryContent(content);
  if (!isSafeMemoryContent(sanitized))
    throw new Error("Unsafe memory content was rejected");
  return sanitized;
}

function operationScope(
  operation: MemoryOperation,
  scopes: MemoryScope[],
  target?: MemoryRow,
) {
  if (operation.action === "add" || operation.action === "refine")
    return scopeForType(scopes, operation.scopeType);
  if (operation.action === "reinforce" || operation.action === "supersede") {
    if (!target) throw new Error("Memory target not found");
    return scopeForType(scopes, target.scopeType);
  }
  return undefined;
}

async function addEvidence(
  tx: any,
  input: {
    userId: string;
    scope: MemoryScope;
    memoryId: string;
    threadId: string;
    messageId: string;
    excerpt: string;
  },
) {
  await tx
    .insert(MemoryEvidenceTable)
    .values({
      id: generateUUID(),
      userId: input.userId,
      ...input.scope,
      memoryId: input.memoryId,
      threadId: input.threadId,
      messageId: input.messageId,
      excerpt: input.excerpt,
      contentHash: memoryContentHash(input.excerpt),
    })
    .onConflictDoNothing();
}

async function recordEvent(
  tx: any,
  memory: MemoryRow,
  action: "create" | "update" | "supersede",
) {
  await tx.insert(UserMemoryEventTable).values({
    id: generateUUID(),
    memoryId: memory.id,
    userId: memory.userId,
    action,
    snapshot: memory,
  });
}

async function attachTaxonomy(
  tx: any,
  input: {
    memory: MemoryRow;
    topicKey: MemoryTopicKey;
    entities: string[];
    confidence: number;
  },
) {
  const scope = {
    scopeType: input.memory.scopeType,
    scopeId: input.memory.scopeId,
  } satisfies MemoryScope;
  const [topic] = await tx
    .insert(MemoryTopicTable)
    .values({
      id: generateUUID(),
      userId: input.memory.userId,
      ...scope,
      label: MEMORY_TOPIC_LABELS[input.topicKey],
      normalizedKey: input.topicKey,
      summary: input.memory.content.slice(0, 600),
      detail: input.memory.content.slice(0, 4_000),
      confidence: confidence(input.confidence),
    })
    .onConflictDoUpdate({
      target: [
        MemoryTopicTable.userId,
        MemoryTopicTable.scopeType,
        MemoryTopicTable.scopeId,
        MemoryTopicTable.normalizedKey,
      ],
      set: { status: "active", updatedAt: new Date() },
    })
    .returning();
  await tx
    .insert(MemoryEdgeTable)
    .values({
      id: generateUUID(),
      userId: input.memory.userId,
      ...scope,
      sourceId: input.memory.id,
      sourceType: "claim",
      targetId: topic.id,
      targetType: "topic",
      type: "ABOUT",
      confidence: confidence(input.confidence),
      provenance: "background_review",
    })
    .onConflictDoNothing();

  for (const rawName of [...new Set(input.entities)].slice(0, 3)) {
    const name = sanitizeMemoryContent(rawName).slice(0, 80);
    if (
      !name ||
      normalizeMemoryText(name) === normalizeMemoryText(input.memory.content)
    )
      continue;
    const [entity] = await tx
      .insert(MemoryEntityTable)
      .values({
        id: generateUUID(),
        userId: input.memory.userId,
        ...scope,
        name,
        normalizedKey: normalizeMemoryText(name),
        confidence: confidence(input.confidence),
      })
      .onConflictDoUpdate({
        target: [
          MemoryEntityTable.userId,
          MemoryEntityTable.scopeType,
          MemoryEntityTable.scopeId,
          MemoryEntityTable.normalizedKey,
        ],
        set: { status: "active", updatedAt: new Date() },
      })
      .returning();
    await tx
      .insert(MemoryEdgeTable)
      .values({
        id: generateUUID(),
        userId: input.memory.userId,
        ...scope,
        sourceId: input.memory.id,
        sourceType: "claim",
        targetId: entity.id,
        targetType: "entity",
        type: "RELATED_TO",
        confidence: confidence(input.confidence),
        provenance: "background_review",
      })
      .onConflictDoNothing();
  }
}

async function findExactActiveClaim(
  tx: any,
  userId: string,
  scope: MemoryScope,
  content: string,
) {
  const rows: MemoryRow[] = await tx
    .select()
    .from(UserMemoryTable)
    .where(
      and(
        eq(UserMemoryTable.userId, userId),
        exactScope(UserMemoryTable, scope),
        eq(UserMemoryTable.status, "active"),
        isNull(UserMemoryTable.deletedAt),
      ),
    )
    .limit(500);
  const normalized = normalizeMemoryText(content);
  return rows.find((row) => normalizeMemoryText(row.content) === normalized);
}

async function createOrReinforceClaim(
  tx: any,
  input: {
    userId: string;
    scope: MemoryScope;
    kind: MemoryKind;
    content: string;
    topicKey: MemoryTopicKey;
    entities: string[];
    confidence: number;
    threadId: string;
    messageId: string;
    evidence: string;
  },
) {
  const content = validateContent(input.content);
  const existing = await findExactActiveClaim(
    tx,
    input.userId,
    input.scope,
    content,
  );
  if (existing) {
    const [memory] = await tx
      .update(UserMemoryTable)
      .set({
        confidence: Math.max(existing.confidence, confidence(input.confidence)),
        frequency: sql`${UserMemoryTable.frequency} + 1`,
        version: sql`${UserMemoryTable.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(UserMemoryTable.id, existing.id))
      .returning();
    await recordEvent(tx, memory, "update");
    await addEvidence(tx, {
      userId: input.userId,
      scope: input.scope,
      memoryId: memory.id,
      threadId: input.threadId,
      messageId: input.messageId,
      excerpt: input.evidence,
    });
    await attachTaxonomy(tx, { ...input, memory });
    return { memory, action: "reinforce" as const };
  }
  const [memory] = await tx
    .insert(UserMemoryTable)
    .values({
      id: generateUUID(),
      userId: input.userId,
      ...input.scope,
      kind: input.kind,
      content,
      confidence: confidence(input.confidence),
      importance: 50,
      frequency: 1,
      stability: 50,
      payload: {},
      status: "active",
      provenance: "background_review",
      sourceThreadId: input.threadId,
      sourceMessageId: input.messageId,
      observedAt: new Date(),
      version: 1,
    })
    .returning();
  await recordEvent(tx, memory, "create");
  await addEvidence(tx, {
    userId: input.userId,
    scope: input.scope,
    memoryId: memory.id,
    threadId: input.threadId,
    messageId: input.messageId,
    excerpt: input.evidence,
  });
  await attachTaxonomy(tx, { ...input, memory });
  return { memory, action: "add" as const };
}

async function deactivateClaimTaxonomy(tx: any, memory: MemoryRow) {
  await tx
    .update(MemoryEdgeTable)
    .set({ status: "superseded", validTo: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(MemoryEdgeTable.userId, memory.userId),
        exactScope(MemoryEdgeTable, {
          scopeType: memory.scopeType,
          scopeId: memory.scopeId,
        }),
        eq(MemoryEdgeTable.sourceId, memory.id),
        inArray(MemoryEdgeTable.type, ["ABOUT", "RELATED_TO", "REFINES"]),
        eq(MemoryEdgeTable.status, "active"),
      ),
    );
}

async function commitOperations(input: {
  runId: string;
  userId: string;
  threadId: string;
  messageId: string;
  userText: string;
  scopes: MemoryScope[];
  allowedScopeTypes: MemoryScope["scopeType"][];
  allowedTargetIds: Set<string>;
  batch: MemoryOperationBatch;
  mode: MemoryCuratorMode;
  consolidation?: boolean;
}) {
  const targets = input.batch.operations
    .filter(
      (operation) =>
        operation.action === "reinforce" ||
        operation.action === "refine" ||
        operation.action === "supersede",
    )
    .map((operation) => operation.targetId);
  if (new Set(targets).size !== targets.length)
    throw new Error("A memory target can only be changed once per batch");
  for (const targetId of targets)
    if (!input.allowedTargetIds.has(targetId))
      throw new Error("Memory target was not returned by search_memory");

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`memory-review:${input.userId}`}))`,
    );
    const [run] = await tx
      .select({ status: MemoryCuratorRunTable.status })
      .from(MemoryCuratorRunTable)
      .where(
        and(
          eq(MemoryCuratorRunTable.id, input.runId),
          eq(MemoryCuratorRunTable.userId, input.userId),
        ),
      )
      .limit(1);
    if (!run) throw new Error("Memory curator run not found");
    if (run.status === "completed")
      throw new Error("Memory curator run was already committed");
    const targetRows: MemoryRow[] = targets.length
      ? await tx
          .select()
          .from(UserMemoryTable)
          .where(
            and(
              eq(UserMemoryTable.userId, input.userId),
              inArray(UserMemoryTable.id, targets),
              eq(UserMemoryTable.status, "active"),
              isNull(UserMemoryTable.deletedAt),
            ),
          )
      : [];
    const targetById = new Map(targetRows.map((row) => [row.id, row]));

    for (const operation of input.batch.operations) {
      if (operation.action === "ignore") {
        if (operation.evidenceQuote)
          validateEvidence(input.userText, operation.evidenceQuote);
        continue;
      }
      validateEvidence(input.userText, operation.evidenceQuote);
      const target =
        "targetId" in operation
          ? targetById.get(operation.targetId)
          : undefined;
      if ("targetId" in operation && !target)
        throw new Error("Memory target is no longer active");
      const scope = operationScope(operation, input.scopes, target);
      if (!scope || !input.allowedScopeTypes.includes(scope.scopeType))
        throw new Error(
          `Memory scope ${scope?.scopeType ?? "unknown"} is disabled`,
        );
      if (target && memoryScopeKey(scope) !== memoryScopeKey(target))
        throw new Error("Memory operation cannot cross scopes");
      if (operation.action === "supersede") {
        if (
          (!operation.explicitCurrentCorrection && !input.consolidation) ||
          operation.confidence < 0.85
        )
          throw new Error(
            "Automatic supersede requires an explicit correction",
          );
        operation.replacements.forEach((replacement) =>
          validateContent(replacement.content),
        );
      } else if (operation.action === "add" || operation.action === "refine") {
        validateContent(operation.content);
      }
    }

    const stats: Record<string, number> = {
      add: 0,
      reinforce: 0,
      refine: 0,
      supersede: 0,
      ignore: 0,
    };
    if (input.mode !== "write") {
      for (const operation of input.batch.operations)
        stats[operation.action] += 1;
      await tx
        .update(MemoryCuratorRunTable)
        .set({
          status: "completed",
          stats,
          rollbackSnapshot: input.batch,
          completedAt: new Date(),
        })
        .where(eq(MemoryCuratorRunTable.id, input.runId));
      return { stats, memoryIds: [] as string[] };
    }

    const memoryIds: string[] = [];
    for (const operation of input.batch.operations) {
      if (operation.action === "ignore") {
        stats.ignore += 1;
        continue;
      }
      const evidence = validateEvidence(
        input.userText,
        operation.evidenceQuote,
      );
      const target =
        "targetId" in operation
          ? targetById.get(operation.targetId)!
          : undefined;
      const scope = operationScope(operation, input.scopes, target)!;
      if (operation.action === "add") {
        const result = await createOrReinforceClaim(tx, {
          ...operation,
          userId: input.userId,
          scope,
          threadId: input.threadId,
          messageId: input.messageId,
          evidence,
        });
        stats[result.action] += 1;
        memoryIds.push(result.memory.id);
        continue;
      }
      if (operation.action === "reinforce") {
        const [memory] = await tx
          .update(UserMemoryTable)
          .set({
            confidence: Math.max(
              target!.confidence,
              confidence(operation.confidence),
            ),
            frequency: sql`${UserMemoryTable.frequency} + 1`,
            version: sql`${UserMemoryTable.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(UserMemoryTable.id, target!.id))
          .returning();
        await recordEvent(tx, memory, "update");
        await addEvidence(tx, {
          userId: input.userId,
          scope,
          memoryId: memory.id,
          threadId: input.threadId,
          messageId: input.messageId,
          excerpt: evidence,
        });
        stats.reinforce += 1;
        memoryIds.push(memory.id);
        continue;
      }
      if (operation.action === "refine") {
        const [memory] = await tx
          .update(UserMemoryTable)
          .set({
            kind: operation.kind,
            content: validateContent(operation.content),
            confidence: Math.max(
              target!.confidence,
              confidence(operation.confidence),
            ),
            version: sql`${UserMemoryTable.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(UserMemoryTable.id, target!.id))
          .returning();
        await recordEvent(tx, memory, "update");
        await deactivateClaimTaxonomy(tx, target!);
        await attachTaxonomy(tx, { ...operation, memory });
        await addEvidence(tx, {
          userId: input.userId,
          scope,
          memoryId: memory.id,
          threadId: input.threadId,
          messageId: input.messageId,
          excerpt: evidence,
        });
        stats.refine += 1;
        memoryIds.push(memory.id);
        continue;
      }

      const [superseded] = await tx
        .update(UserMemoryTable)
        .set({
          status: "superseded",
          validTo: new Date(),
          version: sql`${UserMemoryTable.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(UserMemoryTable.id, target!.id))
        .returning();
      await recordEvent(tx, superseded, "supersede");
      await deactivateClaimTaxonomy(tx, target!);
      for (const replacement of operation.replacements) {
        const result = await createOrReinforceClaim(tx, {
          ...replacement,
          userId: input.userId,
          scope,
          confidence: operation.confidence,
          threadId: input.threadId,
          messageId: input.messageId,
          evidence,
        });
        await tx
          .insert(MemoryEdgeTable)
          .values({
            id: generateUUID(),
            userId: input.userId,
            ...scope,
            sourceId: result.memory.id,
            sourceType: "claim",
            targetId: superseded.id,
            targetType: "claim",
            type: "SUPERSEDES",
            confidence: confidence(operation.confidence),
            provenance: "background_review",
            reason: operation.reason,
          })
          .onConflictDoNothing();
        memoryIds.push(result.memory.id);
      }
      stats.supersede += 1;
    }
    await tx
      .update(MemoryCuratorRunTable)
      .set({
        status: "completed",
        stats,
        rollbackSnapshot: input.batch,
        completedAt: new Date(),
      })
      .where(eq(MemoryCuratorRunTable.id, input.runId));
    return { stats, memoryIds };
  });
}

export const pgMemoryReviewRepository = {
  findCandidates,
  commitOperations,
};
