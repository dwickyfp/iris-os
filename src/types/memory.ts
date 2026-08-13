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
