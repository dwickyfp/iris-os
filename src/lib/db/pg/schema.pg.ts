import { Agent } from "app-types/agent";
import { UserPreferences } from "app-types/user";
import { MCPServerConfig, MCPToolInfo } from "app-types/mcp";
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  json,
  uuid,
  boolean,
  integer,
  unique,
  varchar,
  index,
  check,
} from "drizzle-orm/pg-core";
import { isNotNull } from "drizzle-orm";
import { DBWorkflow, DBEdge, DBNode } from "app-types/workflow";
import { UIMessage } from "ai";
import { ChatMetadata } from "app-types/chat";
import { TipTapMentionJsonContent } from "@/types/util";
import type {
  SkillMetadata,
  SkillProvenance,
  SkillVisibility,
} from "app-types/skill";
import type {
  MemoryEdgeType,
  MemoryGraphStatus,
  MemoryKind,
  MemoryNodeType,
  MemoryProvenance,
  MemoryStatus,
} from "app-types/memory";
import type { Workspace, WorkspaceStatus } from "app-types/workspace";
import type { TaskPriority, TaskStatus } from "app-types/task";

export const WorkspaceTable = pgTable(
  "workspace",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    slug: varchar("slug", { length: 80 }).notNull(),
    description: text("description"),
    instructions: text("instructions"),
    status: varchar("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active")
      .$type<WorkspaceStatus>(),
    defaultModelId: uuid("default_model_id").references(
      () => ModelConfigurationTable.id,
      { onDelete: "set null" },
    ),
    defaultAgentId: uuid("default_agent_id").references(() => AgentTable.id, {
      onDelete: "set null",
    }),
    defaultToolMode: varchar("default_tool_mode", {
      enum: ["auto", "manual", "none"],
    })
      .notNull()
      .default("auto")
      .$type<Workspace["defaultToolMode"]>(),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    unique().on(table.userId, table.slug),
    index("workspace_user_status_idx").on(table.userId, table.status),
  ],
);

export const WorkspaceDeletionTombstoneTable = pgTable(
  "workspace_deletion_tombstone",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    workspaceIdHash: varchar("workspace_id_hash", { length: 64 }).notNull(),
    userIdHash: varchar("user_id_hash", { length: 64 }).notNull(),
    sanitizedCounts: json("sanitized_counts")
      .notNull()
      .$type<Record<string, number>>()
      .default({}),
    deletedAt: timestamp("deleted_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("workspace_tombstone_hash_idx").on(table.workspaceIdHash)],
);

export const TaskTable = pgTable(
  "iris_task",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").references(() => WorkspaceTable.id, {
      onDelete: "set null",
    }),
    parentTaskId: uuid("parent_task_id"),
    assignedAgentId: uuid("assigned_agent_id").references(() => AgentTable.id, {
      onDelete: "set null",
    }),
    title: varchar("title", { length: 240 }).notNull(),
    description: text("description"),
    status: varchar("status", {
      enum: ["planned", "in_progress", "blocked", "completed", "cancelled"],
    })
      .notNull()
      .default("planned")
      .$type<TaskStatus>(),
    priority: varchar("priority", {
      enum: ["low", "normal", "high", "urgent"],
    })
      .notNull()
      .default("normal")
      .$type<TaskPriority>(),
    nextAction: text("next_action"),
    checkpoint: text("checkpoint"),
    dueAt: timestamp("due_at"),
    startedAt: timestamp("started_at"),
    blockedAt: timestamp("blocked_at"),
    completedAt: timestamp("completed_at"),
    cancelledAt: timestamp("cancelled_at"),
    metadata: json("metadata")
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("iris_task_user_status_idx").on(table.userId, table.status),
    index("iris_task_workspace_status_idx").on(table.workspaceId, table.status),
    check(
      "iris_task_terminal_timestamp_check",
      sql`(${table.status} <> 'in_progress' OR ${table.startedAt} IS NOT NULL) AND (${table.status} <> 'blocked' OR (${table.startedAt} IS NOT NULL AND ${table.blockedAt} IS NOT NULL)) AND (${table.status} <> 'completed' OR ${table.completedAt} IS NOT NULL) AND (${table.status} <> 'cancelled' OR ${table.cancelledAt} IS NOT NULL)`,
    ),
  ],
);

export const TaskActivityTable = pgTable(
  "task_activity",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => TaskTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 80 }).notNull(),
    payload: json("payload")
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("task_activity_task_idx").on(table.taskId, table.createdAt),
  ],
);

export const TaskResourceRefTable = pgTable(
  "task_resource_ref",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => TaskTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    kind: varchar("kind", {
      enum: [
        "thread",
        "file",
        "artifact",
        "workflow_run",
        "tool_run",
        "repository",
        "url",
        "decision",
      ],
    }).notNull(),
    referenceId: text("reference_id").notNull(),
    label: varchar("label", { length: 240 }),
    metadata: json("metadata")
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [unique().on(table.taskId, table.kind, table.referenceId)],
);

export const ChatThreadTable = pgTable("chat_thread", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  title: text("title").notNull(),
  userId: uuid("user_id")
    .notNull()
    .references(() => UserTable.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").references(() => WorkspaceTable.id, {
    onDelete: "set null",
  }),
  taskId: uuid("task_id").references(() => TaskTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** Runtime context is separate from visible messages so compaction never removes history. */
export const ChatThreadContextTable = pgTable("chat_thread_context", {
  threadId: uuid("thread_id")
    .primaryKey()
    .notNull()
    .references(() => ChatThreadTable.id, { onDelete: "cascade" }),
  summary: text("summary").notNull().default(""),
  summarizedUntil: timestamp("summarized_until"),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const ModelProviderTable = pgTable(
  "model_provider",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    name: text("name").notNull(),
    type: varchar("type", { length: 32 }).notNull(),
    baseUrl: text("base_url"),
    encryptedApiKey: text("encrypted_api_key"),
    enabled: boolean("enabled").notNull().default(true),
    lastConnectionStatus: varchar("last_connection_status", { length: 16 }),
    lastConnectionError: text("last_connection_error"),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [unique().on(table.name)],
);

export const ModelConfigurationTable = pgTable(
  "model_configuration",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => ModelProviderTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    apiModelId: text("api_model_id").notNull(),
    apiVersion: text("api_version"),
    contextWindow: integer("context_window").notNull().default(128000),
    capabilities: json("capabilities")
      .notNull()
      .default({ toolCalls: true, vision: false, structuredOutput: true }),
    enabled: boolean("enabled").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    modelKind: varchar("model_kind", { enum: ["chat", "embedding"] })
      .notNull()
      .default("chat"),
    isCurator: boolean("is_curator").notNull().default(false),
    isEmbeddingDefault: boolean("is_embedding_default")
      .notNull()
      .default(false),
    embeddingDimensions: integer("embedding_dimensions"),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    unique().on(table.providerId, table.name),
    index("model_configuration_provider_idx").on(table.providerId),
  ],
);

export const ChatMessageTable = pgTable("chat_message", {
  id: text("id").primaryKey().notNull(),
  threadId: uuid("thread_id")
    .notNull()
    .references(() => ChatThreadTable.id, { onDelete: "cascade" }),
  role: text("role").notNull().$type<UIMessage["role"]>(),
  parts: json("parts").notNull().array().$type<UIMessage["parts"]>(),
  metadata: json("metadata").$type<ChatMetadata>(),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** Denormalized, user-scoped text extracted from messages for cross-thread recall. */
export const ChatMessageSearchTable = pgTable(
  "chat_message_search",
  {
    messageId: text("message_id")
      .primaryKey()
      .notNull()
      .references(() => ChatMessageTable.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => ChatThreadTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("chat_message_search_user_idx").on(table.userId)],
);

export const UserMemoryTable = pgTable(
  "user_memory",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    kind: varchar("kind", {
      enum: [
        "identity",
        "preference",
        "semantic",
        "episodic",
        "decision",
        "procedure",
        "operational",
        "relationship",
        "goal",
      ],
    })
      .notNull()
      .$type<MemoryKind>(),
    scopeType: varchar("scope_type", {
      enum: ["global", "workspace", "task", "agent"],
    })
      .notNull()
      .default("global"),
    scopeId: uuid("scope_id"),
    content: text("content").notNull(),
    confidence: integer("confidence").notNull().default(100),
    importance: integer("importance").notNull().default(50),
    frequency: integer("frequency").notNull().default(1),
    stability: integer("stability").notNull().default(50),
    payload: json("payload")
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    status: varchar("status", {
      enum: ["active", "pending", "superseded", "deleted"],
    })
      .notNull()
      .default("active")
      .$type<MemoryStatus>(),
    provenance: varchar("provenance", {
      enum: ["manual", "background_review", "generated", "learned"],
    })
      .notNull()
      .$type<MemoryProvenance>(),
    sourceThreadId: uuid("source_thread_id").references(
      () => ChatThreadTable.id,
      { onDelete: "set null" },
    ),
    sourceMessageId: text("source_message_id").references(
      () => ChatMessageTable.id,
      { onDelete: "set null" },
    ),
    version: integer("version").notNull().default(1),
    expiresAt: timestamp("expires_at"),
    validFrom: timestamp("valid_from"),
    validTo: timestamp("valid_to"),
    observedAt: timestamp("observed_at"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "user_memory_scope_check",
      sql`(${table.scopeType} = 'global' AND ${table.scopeId} IS NULL) OR (${table.scopeType} IN ('workspace', 'task', 'agent') AND ${table.scopeId} IS NOT NULL)`,
    ),
    index("user_memory_user_scope_status_idx").on(
      table.userId,
      table.scopeType,
      table.scopeId,
      table.status,
    ),
  ],
);

export const UserMemoryEventTable = pgTable(
  "user_memory_event",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => UserMemoryTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    action: varchar("action", {
      enum: ["create", "update", "supersede", "delete", "restore"],
    }).notNull(),
    snapshot: json("snapshot").notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("user_memory_event_memory_idx").on(table.memoryId)],
);

export const MemoryTopicTable = pgTable(
  "memory_topic",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", {
      enum: ["global", "workspace", "task", "agent"],
    })
      .notNull()
      .default("global"),
    scopeId: uuid("scope_id"),
    label: varchar("label", { length: 160 }).notNull(),
    normalizedKey: varchar("normalized_key", { length: 180 }).notNull(),
    summary: varchar("summary", { length: 600 }).notNull().default(""),
    detail: varchar("detail", { length: 4000 }).notNull().default(""),
    confidence: integer("confidence").notNull().default(80),
    status: varchar("status", {
      enum: ["active", "pending", "superseded", "deleted"],
    })
      .notNull()
      .default("active")
      .$type<MemoryGraphStatus>(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "memory_topic_scope_check",
      sql`(${table.scopeType} = 'global' AND ${table.scopeId} IS NULL) OR (${table.scopeType} IN ('workspace', 'task', 'agent') AND ${table.scopeId} IS NOT NULL)`,
    ),
    unique().on(
      table.userId,
      table.scopeType,
      table.scopeId,
      table.normalizedKey,
    ),
    index("memory_topic_user_scope_status_idx").on(
      table.userId,
      table.scopeType,
      table.scopeId,
      table.status,
    ),
  ],
);

export const MemoryEntityTable = pgTable(
  "memory_entity",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", {
      enum: ["global", "workspace", "task", "agent"],
    })
      .notNull()
      .default("global"),
    scopeId: uuid("scope_id"),
    name: varchar("name", { length: 240 }).notNull(),
    normalizedKey: varchar("normalized_key", { length: 260 }).notNull(),
    entityType: varchar("entity_type", { length: 64 })
      .notNull()
      .default("concept"),
    aliases: json("aliases").notNull().$type<string[]>().default([]),
    confidence: integer("confidence").notNull().default(80),
    status: varchar("status", {
      enum: ["active", "pending", "superseded", "deleted"],
    })
      .notNull()
      .default("active")
      .$type<MemoryGraphStatus>(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "memory_entity_scope_check",
      sql`(${table.scopeType} = 'global' AND ${table.scopeId} IS NULL) OR (${table.scopeType} IN ('workspace', 'task', 'agent') AND ${table.scopeId} IS NOT NULL)`,
    ),
    unique().on(
      table.userId,
      table.scopeType,
      table.scopeId,
      table.normalizedKey,
    ),
    index("memory_entity_user_scope_status_idx").on(
      table.userId,
      table.scopeType,
      table.scopeId,
      table.status,
    ),
  ],
);

export const MemoryEdgeTable = pgTable(
  "memory_edge",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", {
      enum: ["global", "workspace", "task", "agent"],
    })
      .notNull()
      .default("global"),
    scopeId: uuid("scope_id"),
    sourceId: uuid("source_id").notNull(),
    sourceType: varchar("source_type", { enum: ["topic", "claim", "entity"] })
      .notNull()
      .$type<MemoryNodeType>(),
    targetId: uuid("target_id").notNull(),
    targetType: varchar("target_type", { enum: ["topic", "claim", "entity"] })
      .notNull()
      .$type<MemoryNodeType>(),
    type: varchar("type", {
      enum: [
        "ABOUT",
        "SUPPORTS",
        "REFINES",
        "RELATED_TO",
        "CONTRADICTS",
        "SUPERSEDES",
      ],
    })
      .notNull()
      .$type<MemoryEdgeType>(),
    weight: integer("weight").notNull().default(100),
    confidence: integer("confidence").notNull().default(80),
    provenance: varchar("provenance", {
      enum: ["manual", "background_review", "generated", "learned"],
    })
      .notNull()
      .default("background_review")
      .$type<MemoryProvenance>(),
    reason: text("reason"),
    validFrom: timestamp("valid_from")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    validTo: timestamp("valid_to"),
    status: varchar("status", {
      enum: ["active", "pending", "superseded", "deleted"],
    })
      .notNull()
      .default("active")
      .$type<MemoryGraphStatus>(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "memory_edge_scope_check",
      sql`(${table.scopeType} = 'global' AND ${table.scopeId} IS NULL) OR (${table.scopeType} IN ('workspace', 'task', 'agent') AND ${table.scopeId} IS NOT NULL)`,
    ),
    unique().on(
      table.userId,
      table.scopeType,
      table.scopeId,
      table.sourceId,
      table.targetId,
      table.type,
    ),
    index("memory_edge_user_source_idx").on(table.userId, table.sourceId),
    index("memory_edge_user_target_idx").on(table.userId, table.targetId),
  ],
);

export const MemoryEvidenceTable = pgTable(
  "memory_evidence",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", {
      enum: ["global", "workspace", "task", "agent"],
    })
      .notNull()
      .default("global"),
    scopeId: uuid("scope_id"),
    memoryId: uuid("memory_id").references(() => UserMemoryTable.id, {
      onDelete: "cascade",
    }),
    topicId: uuid("topic_id").references(() => MemoryTopicTable.id, {
      onDelete: "cascade",
    }),
    threadId: uuid("thread_id").references(() => ChatThreadTable.id, {
      onDelete: "set null",
    }),
    messageId: text("message_id").references(() => ChatMessageTable.id, {
      onDelete: "set null",
    }),
    excerpt: text("excerpt").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "memory_evidence_scope_check",
      sql`(${table.scopeType} = 'global' AND ${table.scopeId} IS NULL) OR (${table.scopeType} IN ('workspace', 'task', 'agent') AND ${table.scopeId} IS NOT NULL)`,
    ),
    index("memory_evidence_user_memory_idx").on(table.userId, table.memoryId),
    index("memory_evidence_user_topic_idx").on(table.userId, table.topicId),
  ],
);

/** JSON is the portable source; deployments with pgvector also get vector_value via migration. */
export const MemoryEmbeddingTable = pgTable(
  "memory_embedding",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", {
      enum: ["global", "workspace", "task", "agent"],
    })
      .notNull()
      .default("global"),
    scopeId: uuid("scope_id"),
    nodeId: uuid("node_id").notNull(),
    nodeType: varchar("node_type", { enum: ["topic", "claim", "entity"] })
      .notNull()
      .$type<MemoryNodeType>(),
    model: varchar("model", { length: 180 }).notNull(),
    dimensions: integer("dimensions").notNull(),
    values: json("values").notNull().$type<number[]>(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "memory_embedding_scope_check",
      sql`(${table.scopeType} = 'global' AND ${table.scopeId} IS NULL) OR (${table.scopeType} IN ('workspace', 'task', 'agent') AND ${table.scopeId} IS NOT NULL)`,
    ),
    unique().on(
      table.userId,
      table.scopeType,
      table.scopeId,
      table.nodeId,
      table.model,
    ),
    index("memory_embedding_user_idx").on(table.userId),
  ],
);

export const MemoryCuratorRunTable = pgTable(
  "memory_curator_run",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", {
      enum: ["global", "workspace", "task", "agent"],
    })
      .notNull()
      .default("global"),
    scopeId: uuid("scope_id"),
    jobType: varchar("job_type", {
      enum: ["extract", "curate", "sweep", "reembed"],
    }).notNull(),
    status: varchar("status", {
      enum: ["running", "completed", "failed"],
    }).notNull(),
    stats: json("stats").notNull().$type<Record<string, number>>().default({}),
    error: text("error"),
    rollbackSnapshot: json("rollback_snapshot"),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    check(
      "memory_curator_run_scope_check",
      sql`(${table.scopeType} = 'global' AND ${table.scopeId} IS NULL) OR (${table.scopeType} IN ('workspace', 'task', 'agent') AND ${table.scopeId} IS NOT NULL)`,
    ),
    index("memory_curator_run_user_idx").on(table.userId, table.createdAt),
  ],
);

export const MemoryRetrievalAuditTable = pgTable(
  "memory_retrieval_audit",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", {
      enum: ["global", "workspace", "task", "agent"],
    })
      .notNull()
      .default("global"),
    scopeId: uuid("scope_id"),
    queryHash: varchar("query_hash", { length: 64 }).notNull(),
    seedNodes: json("seed_nodes").notNull().$type<string[]>().default([]),
    traversalPaths: json("traversal_paths")
      .notNull()
      .$type<string[][]>()
      .default([]),
    finalNodes: json("final_nodes").notNull().$type<string[]>().default([]),
    ranking: json("ranking")
      .notNull()
      .$type<Record<string, number>>()
      .default({}),
    tokenCount: integer("token_count").notNull().default(0),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "memory_retrieval_audit_scope_check",
      sql`(${table.scopeType} = 'global' AND ${table.scopeId} IS NULL) OR (${table.scopeType} IN ('workspace', 'task', 'agent') AND ${table.scopeId} IS NOT NULL)`,
    ),
    index("memory_retrieval_audit_user_idx").on(table.userId, table.createdAt),
  ],
);

export const IrisActivityEventTable = pgTable(
  "iris_activity_event",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    schemaVersion: integer("schema_version").notNull().default(1),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    actorType: varchar("actor_type", {
      enum: ["user", "agent", "system"],
    }).notNull(),
    actorId: varchar("actor_id", { length: 160 }),
    scopeType: varchar("scope_type", {
      enum: ["global", "workspace", "task", "agent"],
    })
      .notNull()
      .default("global"),
    scopeId: uuid("scope_id"),
    eventType: varchar("event_type", { length: 120 }).notNull(),
    subjectType: varchar("subject_type", { length: 80 }).notNull(),
    subjectId: varchar("subject_id", { length: 200 }),
    payload: json("payload")
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    requestId: varchar("request_id", { length: 160 }),
    runId: varchar("run_id", { length: 160 }),
    parentRunId: varchar("parent_run_id", { length: 160 }),
    threadId: uuid("thread_id").references(() => ChatThreadTable.id, {
      onDelete: "set null",
    }),
    taskId: uuid("task_id").references(() => TaskTable.id, {
      onDelete: "set null",
    }),
    agentId: uuid("agent_id").references(() => AgentTable.id, {
      onDelete: "set null",
    }),
    idempotencyKey: varchar("idempotency_key", { length: 240 }).notNull(),
    processingStatus: varchar("processing_status", {
      enum: ["pending", "processing", "processed", "failed"],
    })
      .notNull()
      .default("pending"),
    claimedAt: timestamp("claimed_at"),
    claimExpiresAt: timestamp("claim_expires_at"),
    nextAttemptAt: timestamp("next_attempt_at"),
    lastError: text("last_error"),
    processedAt: timestamp("processed_at"),
    processingAttempts: integer("processing_attempts").notNull().default(0),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "iris_activity_event_scope_check",
      sql`(${table.scopeType} = 'global' AND ${table.scopeId} IS NULL) OR (${table.scopeType} IN ('workspace', 'task', 'agent') AND ${table.scopeId} IS NOT NULL)`,
    ),
    check(
      "iris_activity_schema_version_check",
      sql`${table.schemaVersion} BETWEEN 1 AND 20`,
    ),
    unique().on(table.userId, table.idempotencyKey),
    index("iris_activity_unprocessed_idx").on(
      table.processedAt,
      table.createdAt,
    ),
    index("iris_activity_delivery_idx").on(
      table.processingStatus,
      table.nextAttemptAt,
      table.claimExpiresAt,
      table.createdAt,
    ),
    index("iris_activity_scope_idx").on(
      table.userId,
      table.scopeType,
      table.scopeId,
      table.createdAt,
    ),
  ],
);

export const LearningObservationTable = pgTable(
  "learning_observation",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => IrisActivityEventTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", {
      enum: ["global", "workspace", "task", "agent"],
    }).notNull(),
    scopeId: uuid("scope_id"),
    observationType: varchar("observation_type", { length: 80 }).notNull(),
    summary: text("summary").notNull(),
    evidence: json("evidence")
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    confidence: integer("confidence").notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "learning_observation_scope_check",
      sql`(${table.scopeType} = 'global' AND ${table.scopeId} IS NULL) OR (${table.scopeType} IN ('workspace', 'task', 'agent') AND ${table.scopeId} IS NOT NULL)`,
    ),
    check(
      "learning_observation_confidence_check",
      sql`${table.confidence} BETWEEN 0 AND 100`,
    ),
    unique().on(table.eventId, table.observationType),
  ],
);

export const LearningCandidateTable = pgTable(
  "learning_candidate",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    observationId: uuid("observation_id")
      .notNull()
      .references(() => LearningObservationTable.id, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", {
      enum: ["global", "workspace", "task", "agent"],
    }).notNull(),
    scopeId: uuid("scope_id"),
    candidateType: varchar("candidate_type", {
      enum: ["memory", "skill", "automation"],
    }).notNull(),
    title: varchar("title", { length: 240 }).notNull(),
    proposedPayload: json("proposed_payload")
      .notNull()
      .$type<Record<string, unknown>>(),
    confidence: integer("confidence").notNull(),
    status: varchar("status", {
      enum: [
        "collecting",
        "pending",
        "processing",
        "confirmed",
        "ignored",
        "superseded",
      ],
    })
      .notNull()
      .default("pending"),
    suppressionKey: varchar("suppression_key", { length: 64 }).notNull(),
    evidenceCount: integer("evidence_count").notNull().default(1),
    firstObservedAt: timestamp("first_observed_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    lastObservedAt: timestamp("last_observed_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    promotedType: varchar("promoted_type", { length: 40 }),
    promotedId: uuid("promoted_id"),
    reviewedAt: timestamp("reviewed_at"),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "learning_candidate_scope_check",
      sql`(${table.scopeType} = 'global' AND ${table.scopeId} IS NULL) OR (${table.scopeType} IN ('workspace', 'task', 'agent') AND ${table.scopeId} IS NOT NULL)`,
    ),
    check(
      "learning_candidate_confidence_check",
      sql`${table.confidence} BETWEEN 0 AND 100`,
    ),
    check(
      "learning_candidate_evidence_count_check",
      sql`${table.evidenceCount} >= 1`,
    ),
    unique().on(table.userId, table.suppressionKey, table.status),
    index("learning_candidate_inbox_idx").on(table.userId, table.status),
  ],
);

export const LearningCandidateEvidenceTable = pgTable(
  "learning_candidate_evidence",
  {
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => LearningCandidateTable.id, { onDelete: "cascade" }),
    observationId: uuid("observation_id")
      .notNull()
      .references(() => LearningObservationTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    unique().on(table.candidateId, table.observationId),
    index("learning_candidate_evidence_observation_idx").on(
      table.observationId,
    ),
  ],
);

export const LearningSettingTable = pgTable("learning_setting", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => UserTable.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(true),
  allowedScopes: json("allowed_scopes")
    .notNull()
    .$type<Array<"global" | "workspace" | "task" | "agent">>()
    .default(["global", "workspace", "task", "agent"]),
  allowedCategories: json("allowed_categories")
    .notNull()
    .$type<Array<"memory" | "skill" | "automation">>()
    .default(["memory", "skill", "automation"]),
  retentionDays: integer("retention_days").notNull().default(90),
  autonomyLevel: integer("autonomy_level").notNull().default(1),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const LearningSuppressionTable = pgTable(
  "learning_suppression",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", {
      enum: ["global", "workspace", "task", "agent"],
    }).notNull(),
    scopeId: uuid("scope_id"),
    candidateType: varchar("candidate_type", {
      enum: ["memory", "skill", "automation"],
    }).notNull(),
    suppressionKey: varchar("suppression_key", { length: 64 }).notNull(),
    reason: varchar("reason", { length: 240 }),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    unique().on(
      table.userId,
      table.scopeType,
      table.scopeId,
      table.candidateType,
      table.suppressionKey,
    ),
  ],
);

export const LearningFeedbackTable = pgTable(
  "learning_feedback",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => LearningCandidateTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    action: varchar("action", {
      enum: ["confirm", "edit", "ignore", "change_scope"],
    }).notNull(),
    payload: json("payload")
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("learning_feedback_candidate_idx").on(table.candidateId)],
);

export const AutomationTable = pgTable(
  "automation",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").references(() => WorkspaceTable.id, {
      onDelete: "set null",
    }),
    name: varchar("name", { length: 160 }).notNull(),
    status: varchar("status", { enum: ["active", "paused", "archived"] })
      .notNull()
      .default("active"),
    triggerType: varchar("trigger_type", {
      enum: ["manual", "schedule"],
    }).notNull(),
    cron: varchar("cron", { length: 120 }),
    timezone: varchar("timezone", { length: 80 }).notNull().default("UTC"),
    missedRunPolicy: varchar("missed_run_policy", {
      enum: ["skip", "run_once"],
    })
      .notNull()
      .default("skip"),
    targetType: varchar("target_type", {
      enum: ["workflow", "skill", "agent"],
    }).notNull(),
    targetId: uuid("target_id").notNull(),
    approvalPolicy: varchar("approval_policy", {
      enum: ["always", "destructive_only", "never"],
    }).notNull(),
    input: json("input").notNull().$type<Record<string, unknown>>().default({}),
    retryLimit: integer("retry_limit").notNull().default(3),
    timeoutMs: integer("timeout_ms").notNull().default(300000),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("automation_user_status_idx").on(table.userId, table.status),
  ],
);

export const AutomationRunTable = pgTable(
  "automation_run",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => AutomationTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    idempotencyKey: varchar("idempotency_key", { length: 64 }).notNull(),
    status: varchar("status", {
      enum: [
        "queued",
        "awaiting_approval",
        "running",
        "retry_scheduled",
        "succeeded",
        "failed",
        "cancelled",
        "timed_out",
      ],
    })
      .notNull()
      .default("queued"),
    scheduledFor: timestamp("scheduled_for").notNull(),
    attempt: integer("attempt").notNull().default(0),
    approvalStatus: varchar("approval_status", {
      enum: ["not_required", "pending", "approved", "rejected"],
    })
      .notNull()
      .default("not_required"),
    approvedBy: uuid("approved_by").references(() => UserTable.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at"),
    cancelRequestedAt: timestamp("cancel_requested_at"),
    nextAttemptAt: timestamp("next_attempt_at"),
    errorCode: varchar("error_code", { length: 120 }),
    retryable: boolean("retryable").notNull().default(false),
    result: json("result").$type<Record<string, unknown>>(),
    error: text("error"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    unique().on(table.automationId, table.idempotencyKey),
    index("automation_run_history_idx").on(table.automationId, table.createdAt),
    index("automation_run_delivery_idx").on(
      table.status,
      table.nextAttemptAt,
      table.createdAt,
    ),
  ],
);

export const AutomationRunAttemptTable = pgTable(
  "automation_run_attempt",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => AutomationRunTable.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    status: varchar("status", {
      enum: ["running", "succeeded", "failed", "cancelled", "timed_out"],
    }).notNull(),
    result: json("result").$type<Record<string, unknown>>(),
    errorCode: varchar("error_code", { length: 120 }),
    error: text("error"),
    startedAt: timestamp("started_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    unique().on(table.runId, table.attempt),
    index("automation_run_attempt_history_idx").on(table.runId, table.attempt),
  ],
);

export const AgentRunTable = pgTable(
  "agent_run",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => AgentTable.id, {
      onDelete: "set null",
    }),
    parentRunId: uuid("parent_run_id"),
    workspaceId: uuid("workspace_id").references(() => WorkspaceTable.id, {
      onDelete: "set null",
    }),
    taskId: uuid("task_id").references(() => TaskTable.id, {
      onDelete: "set null",
    }),
    status: varchar("status", {
      enum: [
        "queued",
        "running",
        "succeeded",
        "failed",
        "cancelled",
        "timed_out",
      ],
    })
      .notNull()
      .default("queued"),
    context: json("context")
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    allowedTools: json("allowed_tools").notNull().$type<string[]>().default([]),
    timeoutMs: integer("timeout_ms").notNull().default(300000),
    depth: integer("depth").notNull().default(0),
    tokenBudget: integer("token_budget").notNull().default(50000),
    result: json("result").$type<Record<string, unknown>>(),
    error: text("error"),
    errorCode: varchar("error_code", { length: 120 }),
    cancelRequestedAt: timestamp("cancel_requested_at"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check("agent_run_depth_check", sql`${table.depth} BETWEEN 0 AND 3`),
    check(
      "agent_run_token_budget_check",
      sql`${table.tokenBudget} BETWEEN 1000 AND 200000`,
    ),
    index("agent_run_parent_idx").on(table.parentRunId),
  ],
);

export const DelegationRunTable = pgTable(
  "delegation_run",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    parentRunId: uuid("parent_run_id")
      .notNull()
      .references(() => AgentRunTable.id, { onDelete: "cascade" }),
    childRunId: uuid("child_run_id")
      .notNull()
      .references(() => AgentRunTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    objective: text("objective").notNull(),
    status: varchar("status", {
      enum: [
        "queued",
        "running",
        "succeeded",
        "failed",
        "cancelled",
        "timed_out",
      ],
    })
      .notNull()
      .default("queued"),
    result: json("result").$type<Record<string, unknown>>(),
    errorCode: varchar("error_code", { length: 120 }),
    error: text("error"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    unique().on(table.parentRunId, table.childRunId),
    index("delegation_run_status_idx").on(
      table.parentRunId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const AgentTable = pgTable("agent", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  icon: json("icon").$type<Agent["icon"]>(),
  userId: uuid("user_id")
    .notNull()
    .references(() => UserTable.id, { onDelete: "cascade" }),
  instructions: json("instructions").$type<Agent["instructions"]>(),
  visibility: varchar("visibility", {
    enum: ["public", "private", "readonly"],
  })
    .notNull()
    .default("private"),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const SkillTable = pgTable(
  "skill",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    icon: json("icon").$type<Agent["icon"]>(),
    license: text("license"),
    compatibility: text("compatibility"),
    metadata: json("metadata").$type<SkillMetadata>(),
    provenance: varchar("provenance", { enum: ["manual", "background_review"] })
      .notNull()
      .default("manual")
      .$type<SkillProvenance>(),
    sourceCandidateId: uuid("source_candidate_id").references(
      () => LearningCandidateTable.id,
      { onDelete: "set null" },
    ),
    version: integer("version").notNull().default(1),
    allowedTools: json("allowed_tools").$type<string[]>(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    visibility: varchar("visibility", {
      enum: ["private", "readonly"],
    })
      .notNull()
      .default("private")
      .$type<SkillVisibility>(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    archivedAt: timestamp("archived_at"),
  },
  (table) => [
    unique().on(table.userId, table.name),
    index("skill_user_id_idx").on(table.userId),
    check(
      "skill_name_check",
      sql`${table.name} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(${table.name}) between 1 and 64`,
    ),
    check(
      "skill_description_check",
      sql`char_length(${table.description}) between 1 and 1024`,
    ),
    check(
      "skill_body_size_check",
      sql`octet_length(${table.body}) between 1 and 102400`,
    ),
    check(
      "skill_visibility_check",
      sql`${table.visibility} in ('private', 'readonly')`,
    ),
  ],
);

export const SkillFileTable = pgTable(
  "skill_file",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => SkillTable.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    unique().on(table.skillId, table.path),
    index("skill_file_skill_id_idx").on(table.skillId),
    check("skill_file_size_check", sql`${table.size} between 0 and 10485760`),
  ],
);

export const SkillRevisionTable = pgTable(
  "skill_revision",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => SkillTable.id, { onDelete: "cascade" }),
    sourceCandidateId: uuid("source_candidate_id").references(
      () => LearningCandidateTable.id,
      { onDelete: "set null" },
    ),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: varchar("status", {
      enum: ["proposed", "approved", "rejected"],
    }).notNull(),
    snapshot: json("snapshot").notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    reviewedAt: timestamp("reviewed_at"),
  },
  (table) => [
    unique().on(table.skillId, table.version),
    index("skill_revision_history_idx").on(table.skillId, table.version),
  ],
);

export const AgentSkillTable = pgTable(
  "agent_skill",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => AgentTable.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => SkillTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    unique().on(table.agentId, table.skillId),
    unique().on(table.agentId, table.position),
    index("agent_skill_agent_id_idx").on(table.agentId),
    index("agent_skill_skill_id_idx").on(table.skillId),
    check(
      "agent_skill_position_check",
      sql`${table.position} between 0 and 19`,
    ),
  ],
);

export const BookmarkTable = pgTable(
  "bookmark",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    itemId: uuid("item_id").notNull(),
    itemType: varchar("item_type", {
      enum: ["agent", "workflow", "mcp", "skill"],
    }).notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    unique().on(table.userId, table.itemId, table.itemType),
    index("bookmark_user_id_idx").on(table.userId),
    index("bookmark_item_idx").on(table.itemId, table.itemType),
  ],
);

export const McpServerTable = pgTable("mcp_server", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  name: text("name").notNull(),
  config: json("config").notNull().$type<MCPServerConfig>(),
  enabled: boolean("enabled").notNull().default(true),
  userId: uuid("user_id")
    .notNull()
    .references(() => UserTable.id, { onDelete: "cascade" }),
  visibility: varchar("visibility", {
    enum: ["public", "private"],
  })
    .notNull()
    .default("private"),
  toolInfo: json("tool_info").$type<MCPToolInfo[]>(),
  toolInfoUpdatedAt: timestamp("tool_info_updated_at"),
  lastConnectionStatus: varchar("last_connection_status", {
    enum: ["connected", "error"],
  }),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const UserTable = pgTable("user", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  password: text("password"),
  image: text("image"),
  preferences: json("preferences").default({}).$type<UserPreferences>(),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  banned: boolean("banned"),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  role: text("role").notNull().default("user"),
});

// Role tables removed - using Better Auth's built-in role system
// Roles are now managed via the 'role' field on UserTable

export const SessionTable = pgTable("session", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: uuid("user_id")
    .notNull()
    .references(() => UserTable.id, { onDelete: "cascade" }),
  // Admin plugin field (from better-auth generated schema)
  impersonatedBy: text("impersonated_by"),
});

export const AccountTable = pgTable("account", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: uuid("user_id")
    .notNull()
    .references(() => UserTable.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const VerificationTable = pgTable("verification", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").$defaultFn(
    () => /* @__PURE__ */ new Date(),
  ),
  updatedAt: timestamp("updated_at").$defaultFn(
    () => /* @__PURE__ */ new Date(),
  ),
});

// Tool customization table for per-user additional instructions
export const McpToolCustomizationTable = pgTable(
  "mcp_server_tool_custom_instructions",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    mcpServerId: uuid("mcp_server_id")
      .notNull()
      .references(() => McpServerTable.id, { onDelete: "cascade" }),
    prompt: text("prompt"),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [unique().on(table.userId, table.toolName, table.mcpServerId)],
);

export const McpServerCustomizationTable = pgTable(
  "mcp_server_custom_instructions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    mcpServerId: uuid("mcp_server_id")
      .notNull()
      .references(() => McpServerTable.id, { onDelete: "cascade" }),
    prompt: text("prompt"),
    createdAt: timestamp("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [unique().on(table.userId, table.mcpServerId)],
);

export const WorkflowTable = pgTable("workflow", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  version: text("version").notNull().default("0.1.0"),
  name: text("name").notNull(),
  icon: json("icon").$type<DBWorkflow["icon"]>(),
  description: text("description"),
  isPublished: boolean("is_published").notNull().default(false),
  visibility: varchar("visibility", {
    enum: ["public", "private", "readonly"],
  })
    .notNull()
    .default("private"),
  userId: uuid("user_id")
    .notNull()
    .references(() => UserTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const WorkflowNodeDataTable = pgTable(
  "workflow_node",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    version: text("version").notNull().default("0.1.0"),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => WorkflowTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    uiConfig: json("ui_config").$type<DBNode["uiConfig"]>().default({}),
    nodeConfig: json("node_config")
      .$type<Partial<DBNode["nodeConfig"]>>()
      .default({}),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index("workflow_node_kind_idx").on(t.kind)],
);

export const WorkflowEdgeTable = pgTable("workflow_edge", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  version: text("version").notNull().default("0.1.0"),
  workflowId: uuid("workflow_id")
    .notNull()
    .references(() => WorkflowTable.id, { onDelete: "cascade" }),
  source: uuid("source")
    .notNull()
    .references(() => WorkflowNodeDataTable.id, { onDelete: "cascade" }),
  target: uuid("target")
    .notNull()
    .references(() => WorkflowNodeDataTable.id, { onDelete: "cascade" }),
  uiConfig: json("ui_config").$type<DBEdge["uiConfig"]>().default({}),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const ArchiveTable = pgTable("archive", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  userId: uuid("user_id")
    .notNull()
    .references(() => UserTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const ArchiveItemTable = pgTable(
  "archive_item",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    archiveId: uuid("archive_id")
      .notNull()
      .references(() => ArchiveTable.id, { onDelete: "cascade" }),
    itemId: uuid("item_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index("archive_item_item_id_idx").on(t.itemId)],
);

export const McpOAuthSessionTable = pgTable(
  "mcp_oauth_session",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    mcpServerId: uuid("mcp_server_id")
      .notNull()
      .references(() => McpServerTable.id, { onDelete: "cascade" }),
    serverUrl: text("server_url").notNull(),
    clientInfo: json("client_info"),
    tokens: json("tokens"),
    codeVerifier: text("code_verifier"),
    state: text("state").unique(), // OAuth state parameter for current flow (unique for security)
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("mcp_oauth_session_server_id_idx").on(t.mcpServerId),
    index("mcp_oauth_session_state_idx").on(t.state),
    // Partial index for sessions with tokens for better performance
    index("mcp_oauth_session_tokens_idx")
      .on(t.mcpServerId)
      .where(isNotNull(t.tokens)),
  ],
);

export type McpServerEntity = typeof McpServerTable.$inferSelect;
export type ChatThreadEntity = typeof ChatThreadTable.$inferSelect;
export type ChatMessageEntity = typeof ChatMessageTable.$inferSelect;

export type AgentEntity = typeof AgentTable.$inferSelect;
export type SkillEntity = typeof SkillTable.$inferSelect;
export type SkillFileEntity = typeof SkillFileTable.$inferSelect;
export type AgentSkillEntity = typeof AgentSkillTable.$inferSelect;
export type UserEntity = typeof UserTable.$inferSelect;
export type SessionEntity = typeof SessionTable.$inferSelect;

export type ToolCustomizationEntity =
  typeof McpToolCustomizationTable.$inferSelect;
export type McpServerCustomizationEntity =
  typeof McpServerCustomizationTable.$inferSelect;

export const ChatExportTable = pgTable("chat_export", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  title: text("title").notNull(),
  exporterId: uuid("exporter_id")
    .notNull()
    .references(() => UserTable.id, { onDelete: "cascade" }),
  originalThreadId: uuid("original_thread_id"),
  messages: json("messages").notNull().$type<
    Array<{
      id: string;
      role: UIMessage["role"];
      parts: UIMessage["parts"];
      metadata?: ChatMetadata;
    }>
  >(),
  exportedAt: timestamp("exported_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  expiresAt: timestamp("expires_at"),
});

export const ChatExportCommentTable = pgTable("chat_export_comment", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  exportId: uuid("export_id")
    .notNull()
    .references(() => ChatExportTable.id, { onDelete: "cascade" }),
  authorId: uuid("author_id")
    .notNull()
    .references(() => UserTable.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id").references(() => ChatExportCommentTable.id, {
    onDelete: "cascade",
  }),
  content: json("content").notNull().$type<TipTapMentionJsonContent>(),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type ArchiveEntity = typeof ArchiveTable.$inferSelect;
export type ArchiveItemEntity = typeof ArchiveItemTable.$inferSelect;
export type BookmarkEntity = typeof BookmarkTable.$inferSelect;
