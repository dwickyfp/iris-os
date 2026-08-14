import { z } from "zod";

export const MemoryKindSchema = z.enum([
  "identity",
  "preference",
  "semantic",
  "episodic",
  "decision",
  "procedure",
  "operational",
  "relationship",
  "goal",
]);
export const MemoryScopeTypeSchema = z.enum([
  "global",
  "workspace",
  "task",
  "agent",
]);
export const MemoryScopeSchema = z
  .object({
    scopeType: MemoryScopeTypeSchema.default("global"),
    scopeId: z.string().uuid().nullable().optional(),
  })
  .superRefine((scope, context) => {
    if (scope.scopeType === "global" && scope.scopeId) {
      context.addIssue({
        code: "custom",
        message: "Global memory cannot have a scopeId",
        path: ["scopeId"],
      });
    }
    if (scope.scopeType !== "global" && !scope.scopeId) {
      context.addIssue({
        code: "custom",
        message: `${scope.scopeType} memory requires a scopeId`,
        path: ["scopeId"],
      });
    }
  });
export const MemoryStatusSchema = z.enum([
  "active",
  "pending",
  "superseded",
  "deleted",
]);
export const MemoryProvenanceSchema = z.enum(["manual", "background_review"]);

export const UserMemoryBaseInputSchema = z.object({
  kind: MemoryKindSchema,
  content: z.string().min(1).max(2_000),
  confidence: z.number().min(0).max(1).default(1),
  importance: z.number().min(0).max(1).default(0.5),
  frequency: z.number().int().min(1).default(1),
  stability: z.number().min(0).max(1).default(0.5),
  payload: z.record(z.string(), z.unknown()).default({}),
  validFrom: z.coerce.date().optional(),
  validTo: z.coerce.date().optional(),
  observedAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional(),
});
export const UserMemoryInputSchema =
  UserMemoryBaseInputSchema.and(MemoryScopeSchema);
export const UserMemoryUpdateSchema = UserMemoryBaseInputSchema.partial();

export type MemoryKind = z.infer<typeof MemoryKindSchema>;
export type MemoryScopeType = z.infer<typeof MemoryScopeTypeSchema>;
export type MemoryScope = {
  scopeType: MemoryScopeType;
  scopeId: string | null;
};
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;
export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>;
export type UserMemory = z.infer<typeof UserMemoryInputSchema> & {
  id: string;
  userId: string;
  status: MemoryStatus;
  provenance: MemoryProvenance;
  sourceThreadId?: string;
  sourceMessageId?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
};

export const MemoryNodeTypeSchema = z.enum(["topic", "claim", "entity"]);
export const MemoryEdgeTypeSchema = z.enum([
  "ABOUT",
  "SUPPORTS",
  "REFINES",
  "RELATED_TO",
  "CONTRADICTS",
  "SUPERSEDES",
]);
export const MemoryGraphStatusSchema = z.enum([
  "active",
  "pending",
  "superseded",
  "deleted",
]);

export type MemoryNodeType = z.infer<typeof MemoryNodeTypeSchema>;
export type MemoryEdgeType = z.infer<typeof MemoryEdgeTypeSchema>;
export type MemoryGraphStatus = z.infer<typeof MemoryGraphStatusSchema>;

export type MemoryTopic = MemoryScope & {
  id: string;
  userId: string;
  label: string;
  summary: string;
  detail: string;
  confidence: number;
  status: MemoryGraphStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type MemoryEntity = MemoryScope & {
  id: string;
  userId: string;
  name: string;
  entityType: string;
  aliases: string[];
  confidence: number;
  status: MemoryGraphStatus;
};

export type MemoryEdge = MemoryScope & {
  id: string;
  userId: string;
  sourceId: string;
  sourceType: MemoryNodeType;
  targetId: string;
  targetType: MemoryNodeType;
  type: MemoryEdgeType;
  weight: number;
  confidence: number;
  status: MemoryGraphStatus;
  reason?: string;
};

export type MemoryEvidence = MemoryScope & {
  id: string;
  userId: string;
  memoryId?: string;
  topicId?: string;
  threadId?: string;
  messageId?: string;
  excerpt: string;
  createdAt: Date;
};

export type MemoryNode = {
  id: string;
  type: MemoryNodeType;
  label: string;
  category?: MemoryKind;
  status: MemoryGraphStatus;
  confidence: number;
  evidenceCount: number;
  summary?: string;
  detail?: string;
};

export type MemoryGraphView = {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  degradedSemanticSearch: boolean;
};

export type MemoryConflict = {
  edge: MemoryEdge;
  source?: MemoryNode;
  target?: MemoryNode;
};

export type MemoryCuratorRun = {
  id: string;
  userId: string;
  jobType: "extract" | "curate" | "sweep" | "reembed";
  status: "running" | "completed" | "failed";
  stats: Record<string, number>;
  error?: string;
  createdAt: Date;
  completedAt?: Date;
};
