import { z } from "zod";

export const ProviderTypeSchema = z.enum([
  "openai",
  "anthropic",
  "google",
  "xai",
  "groq",
  "openrouter",
  "ollama",
  "azure-openai",
  "openai-compatible",
]);

export type ProviderType = z.infer<typeof ProviderTypeSchema>;

export const ModelCapabilitiesSchema = z.object({
  toolCalls: z.boolean().default(true),
  vision: z.boolean().default(false),
  structuredOutput: z.boolean().default(true),
});

export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const SystemModelEngineKeySchema = z.enum([
  "memory-curator",
  "context-summary",
  "thread-title",
  "automation-runner",
  "delegation-runner",
  "memory-embedding",
]);

export type SystemModelEngineKey = z.infer<
  typeof SystemModelEngineKeySchema
>;

export const SystemModelEngineAssignmentSchema = z.object({
  engineKey: SystemModelEngineKeySchema,
  modelId: z.string().uuid().nullable(),
});

export const ProviderInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: ProviderTypeSchema,
  baseUrl: z.string().url().optional().or(z.literal("")),
  apiKey: z.string().max(4096).optional(),
  enabled: z.boolean().default(true),
});

export const ModelInputSchema = z.object({
  providerId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  apiModelId: z.string().trim().min(1).max(200),
  apiVersion: z.string().trim().max(120).optional().or(z.literal("")),
  contextWindow: z.number().int().min(1024).max(2_000_000).default(128_000),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  modelKind: z.enum(["chat", "embedding"]).default("chat"),
  isCurator: z.boolean().default(false),
  isEmbeddingDefault: z.boolean().default(false),
  embeddingDimensions: z.number().int().min(1).max(65535).optional(),
  capabilities: ModelCapabilitiesSchema.default({
    toolCalls: true,
    vision: false,
    structuredOutput: true,
  }),
});

export type ProviderInput = z.infer<typeof ProviderInputSchema>;
export type ModelInput = z.infer<typeof ModelInputSchema>;

export type ModelCatalogItem = {
  id: string;
  provider: string;
  model: string;
  contextWindow: number;
  capabilities: ModelCapabilities;
  isDefault: boolean;
};
