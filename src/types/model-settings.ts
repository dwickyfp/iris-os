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
