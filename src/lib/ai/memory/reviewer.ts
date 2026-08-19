import { z } from "zod";
import { MemoryKindSchema, MemoryScopeTypeSchema } from "app-types/memory";

export const MemoryCuratorModeSchema = z.enum(["off", "shadow", "write"]);
export type MemoryCuratorMode = z.infer<typeof MemoryCuratorModeSchema>;

export const MemoryRecallModeSchema = z.enum(["keyword", "hybrid"]);
export type MemoryRecallMode = z.infer<typeof MemoryRecallModeSchema>;

export function getMemoryCuratorMode(
  env: Record<string, string | undefined> = process.env,
): MemoryCuratorMode {
  const configured = env.IRIS_MEMORY_CURATOR_MODE;
  return MemoryCuratorModeSchema.catch("shadow").parse(configured);
}

export function getMemoryRecallMode(
  env: Record<string, string | undefined> = process.env,
): MemoryRecallMode {
  const configured = env.IRIS_MEMORY_RECALL_MODE;
  return MemoryRecallModeSchema.catch("keyword").parse(configured);
}

export const MemoryTopicKeySchema = z.enum([
  "identity",
  "preferences.general",
  "preferences.food-drink",
  "preferences.communication",
  "goals",
  "relationships",
  "decisions",
  "procedures",
  "operations",
  "user-facts",
]);

export type MemoryTopicKey = z.infer<typeof MemoryTopicKeySchema>;

export const MEMORY_TOPIC_LABELS: Record<MemoryTopicKey, string> = {
  identity: "Identitas",
  "preferences.general": "Preferensi",
  "preferences.food-drink": "Preferensi makanan dan minuman",
  "preferences.communication": "Gaya komunikasi",
  goals: "Tujuan",
  relationships: "Relasi",
  decisions: "Keputusan",
  procedures: "Prosedur",
  operations: "Konteks operasional",
  "user-facts": "Tentang pengguna",
};

const EvidenceSchema = z.object({
  evidenceQuote: z.string().min(1).max(500),
  reason: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1),
});

const ClaimSchema = z.object({
  kind: MemoryKindSchema,
  content: z.string().min(1).max(2_000),
  topicKey: MemoryTopicKeySchema,
  entities: z.array(z.string().min(1).max(80)).max(3).default([]),
});

const ScopedClaimSchema = ClaimSchema.extend({
  scopeType: MemoryScopeTypeSchema,
});

export const MemoryOperationSchema = z.discriminatedUnion("action", [
  EvidenceSchema.merge(ScopedClaimSchema).extend({
    action: z.literal("add"),
  }),
  EvidenceSchema.extend({
    action: z.literal("reinforce"),
    targetId: z.string().uuid(),
  }),
  EvidenceSchema.merge(ScopedClaimSchema).extend({
    action: z.literal("refine"),
    targetId: z.string().uuid(),
  }),
  EvidenceSchema.extend({
    action: z.literal("supersede"),
    targetId: z.string().uuid(),
    explicitCurrentCorrection: z.boolean(),
    replacements: z.array(ClaimSchema).min(1).max(4),
  }),
  z.object({
    action: z.literal("ignore"),
    evidenceQuote: z.string().max(500).optional(),
    reason: z.string().min(1).max(300),
  }),
]);

export const MemoryOperationBatchSchema = z.object({
  operations: z.array(MemoryOperationSchema).max(8),
});

export type MemoryOperation = z.infer<typeof MemoryOperationSchema>;
export type MemoryOperationBatch = z.infer<typeof MemoryOperationBatchSchema>;

export type MemorySearchCandidate = {
  id: string;
  kind: z.infer<typeof MemoryKindSchema>;
  scopeType: z.infer<typeof MemoryScopeTypeSchema>;
  scopeId: string | null;
  content: string;
  confidence: number;
  frequency: number;
  status: "active" | "pending";
  updatedAt: Date;
};

export const MEMORY_REVIEWER_INSTRUCTIONS = `You are IRIS's private background memory reviewer. Review a completed conversation after the user has already received the answer.

Your only purpose is to keep durable user memory accurate, compact, and atomic.

Rules:
- Analyze meaning with the model. Never infer memory from keyword or phrase templates.
- Save only explicit durable first-person facts, preferences, relationships, stable goals, decisions, procedures, or operating context stated by the user.
- Never save questions, hypotheticals, sarcasm, quoted text, assistant claims, third-party preferences, temporary state, credentials, health/financial secrets, or uncertain implications.
- Split compound statements into independent atomic claims. One claim must remain independently correct when another clause changes.
- Personal identity, general preferences, relationships, and personal goals belong to global scope even when spoken inside a workspace. Project facts and decisions belong to workspace; task-only context belongs to task; behavior requested only for a particular agent belongs to agent.
- Before proposing any add, reinforce, refine, or supersede operation, call search_memory with a concise semantic query for the possible fact. Search again for another independent fact when needed.
- Repetition reinforces the existing claim. A more precise statement refines it. An explicit present-tense correction supersedes it.
- Supersede only when the current user explicitly corrects their own current fact. Preserve every still-valid part of a compound old claim as an atomic replacement.
- Use only target IDs returned by search_memory in this run.
- Call commit_memory_operations at most once, with every operation in one atomic batch. If nothing is durable, commit an empty batch or ignore operations.
- Entity labels are optional concrete concepts, never a copy of the whole claim.
- Do not mention this review to the user.`;

export function buildMemoryReviewerPrompt(input: {
  transcript: Array<{ role: "user" | "assistant"; content: string }>;
  availableScopes: Array<{ scopeType: string; scopeId: string | null }>;
}) {
  const transcript = input.transcript
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
  return `Available owned scopes:\n${JSON.stringify(input.availableScopes)}\n\nConversation snapshot (the final USER/ASSISTANT pair is the completed turn to review):\n\n${transcript}`;
}
