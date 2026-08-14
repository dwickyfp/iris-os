import { z } from "zod";

export const MemoryKindSchema = z.enum(["preference", "fact", "goal"]);
export const MemoryStatusSchema = z.enum([
  "active",
  "pending",
  "superseded",
  "deleted",
]);
export const MemoryProvenanceSchema = z.enum(["manual", "background_review"]);

export const UserMemoryInputSchema = z.object({
  kind: MemoryKindSchema,
  content: z.string().min(1).max(2_000),
  confidence: z.number().min(0).max(1).default(1),
  expiresAt: z.coerce.date().optional(),
});

export type MemoryKind = z.infer<typeof MemoryKindSchema>;
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

export type MemoryTopic = {
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

export type MemoryEntity = {
  id: string;
  userId: string;
  name: string;
  entityType: string;
  aliases: string[];
  confidence: number;
  status: MemoryGraphStatus;
};

export type MemoryEdge = {
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

export type MemoryEvidence = {
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
