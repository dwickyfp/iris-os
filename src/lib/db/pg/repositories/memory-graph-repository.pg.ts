import { createHash } from "node:crypto";
import { embed } from "ai";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type {
  MemoryConflict,
  MemoryEdge,
  MemoryEvidence,
  MemoryKind,
  MemoryNode,
  MemoryProvenance,
  MemoryScope,
} from "app-types/memory";
import type { MemoryGraphAdapter } from "lib/ai/memory/graph-adapter";
import { customModelProvider } from "lib/ai/models";
import {
  classifyMemoryRelation,
  extractEntityName,
  inferMemoryTopic,
  memoryContentHash,
  normalizeMemoryText,
} from "lib/ai/memory/curator";
import { memoryScopeKey } from "lib/ai/memory/scope";
import { generateUUID } from "lib/utils";
import { pgDb as db } from "../db.pg";
import {
  MemoryCuratorRunTable,
  MemoryEdgeTable,
  MemoryEntityTable,
  MemoryEvidenceTable,
  MemoryRetrievalAuditTable,
  MemoryTopicTable,
  UserMemoryEventTable,
  UserMemoryTable,
} from "../schema.pg";

function confidence(value: number) {
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

const GLOBAL_SCOPE: MemoryScope = { scopeType: "global", scopeId: null };

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

function toEdge(row: typeof MemoryEdgeTable.$inferSelect): MemoryEdge {
  return {
    ...row,
    confidence: row.confidence / 100,
    weight: row.weight / 100,
    reason: row.reason ?? undefined,
  };
}

function claimNode(
  row: typeof UserMemoryTable.$inferSelect,
  evidenceCount = 0,
): MemoryNode {
  return {
    id: row.id,
    type: "claim",
    label: row.content,
    category: row.kind,
    status: row.status,
    confidence: row.confidence / 100,
    evidenceCount,
  };
}

async function vectorAvailable() {
  try {
    const result = await db.execute<{ available: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS available`,
    );
    return Boolean(result.rows[0]?.available);
  } catch {
    return false;
  }
}

async function nodesByIds(
  userId: string,
  scope: MemoryScope,
  ids?: string[],
): Promise<MemoryNode[]> {
  const idFilter = ids?.length ? inArray(UserMemoryTable.id, ids) : undefined;
  const topicFilter = ids?.length
    ? inArray(MemoryTopicTable.id, ids)
    : undefined;
  const entityFilter = ids?.length
    ? inArray(MemoryEntityTable.id, ids)
    : undefined;
  const [claims, topics, entities, counts] = await Promise.all([
    db
      .select()
      .from(UserMemoryTable)
      .where(
        and(
          eq(UserMemoryTable.userId, userId),
          exactScope(UserMemoryTable, scope),
          idFilter,
          isNull(UserMemoryTable.deletedAt),
        ),
      ),
    db
      .select()
      .from(MemoryTopicTable)
      .where(
        and(
          eq(MemoryTopicTable.userId, userId),
          exactScope(MemoryTopicTable, scope),
          topicFilter,
        ),
      ),
    db
      .select()
      .from(MemoryEntityTable)
      .where(
        and(
          eq(MemoryEntityTable.userId, userId),
          exactScope(MemoryEntityTable, scope),
          entityFilter,
        ),
      ),
    db
      .select({
        memoryId: MemoryEvidenceTable.memoryId,
        count: sql<number>`count(*)::int`,
      })
      .from(MemoryEvidenceTable)
      .where(
        and(
          eq(MemoryEvidenceTable.userId, userId),
          exactScope(MemoryEvidenceTable, scope),
        ),
      )
      .groupBy(MemoryEvidenceTable.memoryId),
  ]);
  const evidence = new Map(counts.map((row) => [row.memoryId, row.count]));
  return [
    ...claims.map((row) => claimNode(row, evidence.get(row.id) ?? 0)),
    ...topics.map(
      (row): MemoryNode => ({
        id: row.id,
        type: "topic" as const,
        label: row.label,
        status: row.status,
        confidence: row.confidence / 100,
        evidenceCount: 0,
        summary: row.summary,
        detail: row.detail,
      }),
    ),
    ...entities.map(
      (row): MemoryNode => ({
        id: row.id,
        type: "entity" as const,
        label: row.name,
        status: row.status,
        confidence: row.confidence / 100,
        evidenceCount: 0,
      }),
    ),
  ];
}

export const pgMemoryGraphRepository: MemoryGraphAdapter & {
  curateClaim(input: {
    userId: string;
    kind: MemoryKind;
    content: string;
    confidence: number;
    importance?: number;
    frequency?: number;
    stability?: number;
    payload?: Record<string, unknown>;
    validFrom?: Date;
    validTo?: Date;
    observedAt?: Date;
    expiresAt?: Date;
    provenance: MemoryProvenance;
    scope?: MemoryScope;
    threadId?: string;
    messageId?: string;
  }): Promise<{ action: string; memoryId: string }>;
  hybridRecall(
    userId: string,
    query: string,
    limit?: number,
    scope?: MemoryScope,
  ): Promise<{ nodes: MemoryNode[]; paths: string[][] }>;
  activity(
    userId: string,
    scope?: MemoryScope,
  ): Promise<(typeof MemoryCuratorRunTable.$inferSelect)[]>;
  sweep(userId: string, scope?: MemoryScope): Promise<void>;
} = {
  async overview(userId, scope = GLOBAL_SCOPE) {
    const nodes = (await nodesByIds(userId, scope))
      .filter((node) => node.status === "active")
      .slice(0, 500);
    const nodeIds = nodes.map((node) => node.id);
    const edges = nodeIds.length
      ? await db
          .select()
          .from(MemoryEdgeTable)
          .where(
            and(
              eq(MemoryEdgeTable.userId, userId),
              exactScope(MemoryEdgeTable, scope),
              eq(MemoryEdgeTable.status, "active"),
              inArray(MemoryEdgeTable.sourceId, nodeIds),
              inArray(MemoryEdgeTable.targetId, nodeIds),
            ),
          )
          .limit(1000)
      : [];
    return {
      nodes,
      edges: edges.map(toEdge),
      degradedSemanticSearch: !(await vectorAvailable()),
    };
  },
  async neighbors(userId, nodeId, depth, scope = GLOBAL_SCOPE) {
    const visited = new Set([nodeId]);
    let frontier = [nodeId];
    const edgeMap = new Map<string, typeof MemoryEdgeTable.$inferSelect>();
    for (let hop = 0; hop < Math.min(3, Math.max(1, depth)); hop++) {
      if (!frontier.length) break;
      const rows = await db
        .select()
        .from(MemoryEdgeTable)
        .where(
          and(
            eq(MemoryEdgeTable.userId, userId),
            exactScope(MemoryEdgeTable, scope),
            inArray(MemoryEdgeTable.status, ["active", "pending"]),
            or(
              inArray(MemoryEdgeTable.sourceId, frontier),
              inArray(MemoryEdgeTable.targetId, frontier),
            ),
          ),
        )
        .limit(1000);
      const next: string[] = [];
      for (const row of rows) {
        edgeMap.set(row.id, row);
        for (const id of [row.sourceId, row.targetId])
          if (!visited.has(id)) {
            visited.add(id);
            next.push(id);
          }
      }
      frontier = next;
    }
    return {
      nodes: await nodesByIds(userId, scope, [...visited]),
      edges: [...edgeMap.values()].map(toEdge),
      degradedSemanticSearch: !(await vectorAvailable()),
    };
  },
  async conflicts(userId, scope = GLOBAL_SCOPE) {
    const edges = await db
      .select()
      .from(MemoryEdgeTable)
      .where(
        and(
          eq(MemoryEdgeTable.userId, userId),
          exactScope(MemoryEdgeTable, scope),
          eq(MemoryEdgeTable.type, "CONTRADICTS"),
          eq(MemoryEdgeTable.status, "pending"),
        ),
      )
      .orderBy(desc(MemoryEdgeTable.createdAt));
    const nodes = await nodesByIds(userId, scope, [
      ...new Set(edges.flatMap((edge) => [edge.sourceId, edge.targetId])),
    ]);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return edges.map(
      (edge): MemoryConflict => ({
        edge: toEdge(edge),
        source: byId.get(edge.sourceId),
        target: byId.get(edge.targetId),
      }),
    );
  },
  async provenance(userId, nodeId, nodeType = "claim", scope = GLOBAL_SCOPE) {
    const evidence = await db
      .select()
      .from(MemoryEvidenceTable)
      .where(
        and(
          eq(MemoryEvidenceTable.userId, userId),
          exactScope(MemoryEvidenceTable, scope),
          nodeType === "topic"
            ? eq(MemoryEvidenceTable.topicId, nodeId)
            : eq(MemoryEvidenceTable.memoryId, nodeId),
        ),
      )
      .orderBy(desc(MemoryEvidenceTable.createdAt));
    const history =
      nodeType === "claim"
        ? await db
            .select()
            .from(UserMemoryEventTable)
            .where(
              and(
                eq(UserMemoryEventTable.userId, userId),
                eq(UserMemoryEventTable.memoryId, nodeId),
              ),
            )
            .orderBy(desc(UserMemoryEventTable.createdAt))
        : [];
    return {
      evidence: evidence.map(
        (row): MemoryEvidence => ({
          ...row,
          memoryId: row.memoryId ?? undefined,
          topicId: row.topicId ?? undefined,
          threadId: row.threadId ?? undefined,
          messageId: row.messageId ?? undefined,
        }),
      ),
      history,
    };
  },
  async resolveConflict(userId, edgeId, resolution, scope = GLOBAL_SCOPE) {
    await db.transaction(async (tx) => {
      const [edge] = await tx
        .select()
        .from(MemoryEdgeTable)
        .where(
          and(
            eq(MemoryEdgeTable.id, edgeId),
            eq(MemoryEdgeTable.userId, userId),
            exactScope(MemoryEdgeTable, scope),
            eq(MemoryEdgeTable.type, "CONTRADICTS"),
          ),
        )
        .limit(1);
      if (!edge) throw new Error("Conflict not found");
      if (resolution !== "both") {
        const loser = resolution === "source" ? edge.targetId : edge.sourceId;
        const [memory] = await tx
          .update(UserMemoryTable)
          .set({ status: "superseded", updatedAt: new Date() })
          .where(
            and(
              eq(UserMemoryTable.id, loser),
              eq(UserMemoryTable.userId, userId),
              exactScope(UserMemoryTable, scope),
            ),
          )
          .returning();
        if (memory)
          await tx.insert(UserMemoryEventTable).values({
            id: generateUUID(),
            memoryId: memory.id,
            userId,
            action: "supersede",
            snapshot: memory,
          });
      }
      await tx
        .update(MemoryEdgeTable)
        .set({
          status: "superseded",
          validTo: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(MemoryEdgeTable.id, edgeId),
            eq(MemoryEdgeTable.userId, userId),
            exactScope(MemoryEdgeTable, scope),
          ),
        );
    });
  },
  async connect(userId, edge) {
    const endpointIds = [...new Set([edge.sourceId, edge.targetId])];
    const endpoints = await nodesByIds(userId, edge, endpointIds);
    if (endpoints.length !== endpointIds.length) {
      throw new Error("Memory edges cannot cross scopes");
    }
    await db
      .insert(MemoryEdgeTable)
      .values({
        ...edge,
        id: generateUUID(),
        userId,
        confidence: confidence(edge.confidence),
        weight: confidence(edge.weight),
      })
      .onConflictDoNothing();
  },
  async curateClaim(input) {
    const scope = input.scope ?? GLOBAL_SCOPE;
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.userId}:${memoryScopeKey(scope)}`}))`,
      );
      const active = await tx
        .select()
        .from(UserMemoryTable)
        .where(
          and(
            eq(UserMemoryTable.userId, input.userId),
            exactScope(UserMemoryTable, scope),
            inArray(UserMemoryTable.status, ["active", "pending"]),
            isNull(UserMemoryTable.deletedAt),
          ),
        )
        .orderBy(desc(UserMemoryTable.updatedAt))
        .limit(500);
      const related = active
        .map((row) => ({
          row,
          relation: classifyMemoryRelation(row.content, input.content),
        }))
        .find((item) => item.relation !== "new");
      if (related?.relation === "duplicate") {
        await tx.insert(MemoryEvidenceTable).values({
          id: generateUUID(),
          userId: input.userId,
          ...scope,
          memoryId: related.row.id,
          threadId: input.threadId,
          messageId: input.messageId,
          excerpt: input.content,
          contentHash: memoryContentHash(input.content),
        });
        return { action: "duplicate", memoryId: related.row.id };
      }
      if (
        related?.relation === "refinement" &&
        related.row.provenance === "background_review"
      ) {
        const nextContent =
          input.content.length >= related.row.content.length
            ? input.content
            : related.row.content;
        const [memory] = await tx
          .update(UserMemoryTable)
          .set({
            content: nextContent,
            confidence: Math.max(
              related.row.confidence,
              confidence(input.confidence),
            ),
            version: sql`${UserMemoryTable.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(UserMemoryTable.id, related.row.id),
              eq(UserMemoryTable.userId, input.userId),
              exactScope(UserMemoryTable, scope),
            ),
          )
          .returning();
        await tx.insert(UserMemoryEventTable).values({
          id: generateUUID(),
          memoryId: memory.id,
          userId: input.userId,
          action: "update",
          snapshot: memory,
        });
        await tx.insert(MemoryEvidenceTable).values({
          id: generateUUID(),
          userId: input.userId,
          ...scope,
          memoryId: memory.id,
          threadId: input.threadId,
          messageId: input.messageId,
          excerpt: input.content,
          contentHash: memoryContentHash(input.content),
        });
        return { action: "refinement", memoryId: memory.id };
      }
      const [memory] = await tx
        .insert(UserMemoryTable)
        .values({
          id: generateUUID(),
          userId: input.userId,
          ...scope,
          kind: input.kind,
          content: input.content,
          confidence: confidence(input.confidence),
          importance: confidence(input.importance ?? 0.5),
          frequency: input.frequency ?? 1,
          stability: confidence(input.stability ?? 0.5),
          payload: input.payload ?? {},
          validFrom: input.validFrom,
          validTo: input.validTo,
          observedAt: input.observedAt ?? new Date(),
          expiresAt: input.expiresAt,
          status: related?.relation === "conflict" ? "pending" : "active",
          provenance: input.provenance,
          sourceThreadId: input.threadId,
          sourceMessageId: input.messageId,
          version: 1,
        })
        .returning();
      await tx.insert(UserMemoryEventTable).values({
        id: generateUUID(),
        memoryId: memory.id,
        userId: input.userId,
        action: "create",
        snapshot: memory,
      });
      await tx.insert(MemoryEvidenceTable).values({
        id: generateUUID(),
        userId: input.userId,
        ...scope,
        memoryId: memory.id,
        threadId: input.threadId,
        messageId: input.messageId,
        excerpt: input.content,
        contentHash: memoryContentHash(input.content),
      });
      const topic = inferMemoryTopic(input.kind, input.content);
      const [topicRow] = await tx
        .insert(MemoryTopicTable)
        .values({
          id: generateUUID(),
          userId: input.userId,
          ...scope,
          label: topic.label,
          normalizedKey: topic.key,
          summary: input.content.slice(0, 600),
          detail: input.content.slice(0, 4000),
          confidence: confidence(input.confidence),
        })
        .onConflictDoUpdate({
          target: [
            MemoryTopicTable.userId,
            MemoryTopicTable.scopeType,
            MemoryTopicTable.scopeId,
            MemoryTopicTable.normalizedKey,
          ],
          set: { updatedAt: new Date() },
        })
        .returning();
      const entityName = extractEntityName(input.content);
      const [entity] = entityName
        ? await tx
            .insert(MemoryEntityTable)
            .values({
              id: generateUUID(),
              userId: input.userId,
              ...scope,
              name: entityName,
              normalizedKey: normalizeMemoryText(entityName),
              confidence: confidence(input.confidence),
            })
            .onConflictDoUpdate({
              target: [
                MemoryEntityTable.userId,
                MemoryEntityTable.scopeType,
                MemoryEntityTable.scopeId,
                MemoryEntityTable.normalizedKey,
              ],
              set: { updatedAt: new Date() },
            })
            .returning()
        : [];
      await tx
        .insert(MemoryEdgeTable)
        .values({
          id: generateUUID(),
          userId: input.userId,
          ...scope,
          sourceId: memory.id,
          sourceType: "claim",
          targetId: topicRow.id,
          targetType: "topic",
          type: "ABOUT",
          weight: 100,
          confidence: confidence(input.confidence),
          provenance: input.provenance,
        })
        .onConflictDoNothing();
      if (entity)
        await tx
          .insert(MemoryEdgeTable)
          .values({
            id: generateUUID(),
            userId: input.userId,
            ...scope,
            sourceId: memory.id,
            sourceType: "claim",
            targetId: entity.id,
            targetType: "entity",
            type: "RELATED_TO",
            weight: 90,
            confidence: confidence(input.confidence),
            provenance: input.provenance,
          })
          .onConflictDoNothing();
      if (related)
        await tx
          .insert(MemoryEdgeTable)
          .values({
            id: generateUUID(),
            userId: input.userId,
            ...scope,
            sourceId: memory.id,
            sourceType: "claim",
            targetId: related.row.id,
            targetType: "claim",
            type: related.relation === "conflict" ? "CONTRADICTS" : "REFINES",
            weight: 100,
            confidence: confidence(input.confidence),
            provenance: input.provenance,
            status: related.relation === "conflict" ? "pending" : "active",
            reason:
              related.relation === "conflict"
                ? "Same subject with opposite polarity"
                : "More specific statement about the same subject",
          })
          .onConflictDoNothing();
      return { action: related?.relation ?? "new", memoryId: memory.id };
    });
  },
  async hybridRecall(userId, query, limit = 8, scope = GLOBAL_SCOPE) {
    const terms = normalizeMemoryText(query)
      .split(" ")
      .filter((term) => term.length > 2)
      .slice(0, 10);
    const pattern = `%${terms.join("%")}%`;
    const claims = await db
      .select()
      .from(UserMemoryTable)
      .where(
        and(
          eq(UserMemoryTable.userId, userId),
          exactScope(UserMemoryTable, scope),
          eq(UserMemoryTable.status, "active"),
          isNull(UserMemoryTable.deletedAt),
          terms.length
            ? or(
                ...terms.map(
                  (term) =>
                    sql`${UserMemoryTable.content} ILIKE ${`%${term}%`}`,
                ),
              )
            : undefined,
        ),
      )
      .orderBy(
        desc(UserMemoryTable.confidence),
        desc(UserMemoryTable.updatedAt),
      )
      .limit(limit);
    let semanticIds: string[] = [];
    try {
      const configured = await customModelProvider.getEmbeddingModel();
      if (configured && (await vectorAvailable())) {
        const result = await embed({ model: configured.model, value: query });
        const vector = `[${result.embedding.join(",")}]`;
        const semantic = await db.execute<{ node_id: string }>(
          sql`SELECT node_id FROM memory_embedding WHERE user_id = ${userId} AND scope_type = ${scope.scopeType} AND scope_id IS NOT DISTINCT FROM ${scope.scopeId} AND model = ${configured.modelId} AND vector_value IS NOT NULL ORDER BY vector_value <=> ${vector}::vector LIMIT ${limit}`,
        );
        semanticIds = semantic.rows.map((row) => row.node_id);
      }
    } catch {
      // Semantic retrieval is optional; lexical and graph traversal remain live.
    }
    const semanticClaims = semanticIds.length
      ? await db
          .select()
          .from(UserMemoryTable)
          .where(
            and(
              eq(UserMemoryTable.userId, userId),
              exactScope(UserMemoryTable, scope),
              eq(UserMemoryTable.status, "active"),
              inArray(UserMemoryTable.id, semanticIds),
            ),
          )
      : [];
    const mergedClaims = [
      ...claims,
      ...semanticClaims.filter(
        (candidate) => !claims.some((claim) => claim.id === candidate.id),
      ),
    ].slice(0, limit);
    const seeds = mergedClaims.length
      ? mergedClaims
      : await db
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
          .orderBy(desc(UserMemoryTable.updatedAt))
          .limit(Math.min(4, limit));
    const seedIds = seeds.map((row) => row.id);
    const edges = seedIds.length
      ? await db
          .select()
          .from(MemoryEdgeTable)
          .where(
            and(
              eq(MemoryEdgeTable.userId, userId),
              exactScope(MemoryEdgeTable, scope),
              eq(MemoryEdgeTable.status, "active"),
              or(
                inArray(MemoryEdgeTable.sourceId, seedIds),
                inArray(MemoryEdgeTable.targetId, seedIds),
              ),
            ),
          )
          .limit(100)
      : [];
    const ids = [
      ...new Set([
        ...seedIds,
        ...edges.flatMap((edge) => [edge.sourceId, edge.targetId]),
      ]),
    ];
    const nodes = (await nodesByIds(userId, scope, ids))
      .filter((node) => node.status === "active")
      .slice(0, limit + 4);
    const ranking = Object.fromEntries(
      nodes.map((node, index) => [
        node.id,
        1 - index / Math.max(1, nodes.length),
      ]),
    );
    await db.insert(MemoryRetrievalAuditTable).values({
      id: generateUUID(),
      userId,
      ...scope,
      queryHash: createHash("sha256").update(query).digest("hex"),
      seedNodes: seedIds,
      traversalPaths: edges.map((edge) => [edge.sourceId, edge.targetId]),
      finalNodes: nodes.map((node) => node.id),
      ranking,
      tokenCount: Math.ceil(
        nodes.reduce(
          (sum, node) => sum + node.label.length + (node.detail?.length ?? 0),
          0,
        ) / 4,
      ),
    });
    void pattern;
    return {
      nodes,
      paths: edges.map((edge) => [edge.sourceId, edge.targetId]),
    };
  },
  async activity(userId, scope = GLOBAL_SCOPE) {
    return db
      .select()
      .from(MemoryCuratorRunTable)
      .where(
        and(
          eq(MemoryCuratorRunTable.userId, userId),
          exactScope(MemoryCuratorRunTable, scope),
        ),
      )
      .orderBy(desc(MemoryCuratorRunTable.createdAt))
      .limit(100);
  },
  async sweep(userId, scope = GLOBAL_SCOPE) {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`${userId}:${memoryScopeKey(scope)}`}))`,
      );
      const topics = await tx
        .select()
        .from(MemoryTopicTable)
        .where(
          and(
            eq(MemoryTopicTable.userId, userId),
            exactScope(MemoryTopicTable, scope),
            eq(MemoryTopicTable.status, "active"),
          ),
        );
      for (const topic of topics) {
        const claims = await tx
          .select({ content: UserMemoryTable.content })
          .from(MemoryEdgeTable)
          .innerJoin(
            UserMemoryTable,
            and(
              eq(MemoryEdgeTable.sourceId, UserMemoryTable.id),
              eq(UserMemoryTable.userId, userId),
              exactScope(UserMemoryTable, scope),
            ),
          )
          .where(
            and(
              eq(MemoryEdgeTable.userId, userId),
              exactScope(MemoryEdgeTable, scope),
              eq(MemoryEdgeTable.targetId, topic.id),
              eq(MemoryEdgeTable.type, "ABOUT"),
              eq(UserMemoryTable.status, "active"),
            ),
          )
          .limit(100);
        const contents = [...new Set(claims.map((row) => row.content))];
        if (contents.length)
          await tx
            .update(MemoryTopicTable)
            .set({
              summary: contents.slice(0, 3).join("; ").slice(0, 600),
              detail: contents.join("\n").slice(0, 4000),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(MemoryTopicTable.id, topic.id),
                eq(MemoryTopicTable.userId, userId),
                exactScope(MemoryTopicTable, scope),
              ),
            );
      }
    });
  },
};
