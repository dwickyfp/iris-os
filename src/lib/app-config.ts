import { z } from "zod";

// Static application configuration. These values are intentionally not
// editable from the admin UI; override them via environment variables and
// restart, or rely on the defaults below.

const timeout = z.coerce.number().int().min(1).max(300_000);

const staticConfigSchema = z.object({
  BETTER_AUTH_URL: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//i.test(value), "Must use HTTP or HTTPS")
    .nullish()
    .catch(null),
  DEFAULT_USER_ROLE: z.enum(["admin", "editor", "user"]).catch("user"),
  EXA_BASE_URL: z.string().url().catch("https://api.exa.ai"),
  IRIS_MEMORY_CURATOR_MODE: z.enum(["off", "shadow", "write"]).catch("shadow"),
  CAPABILITY_ROUTER_THRESHOLD: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .catch(20),
  CAPABILITY_ROUTER_TOP_N: z.coerce.number().int().min(1).max(1_000).catch(12),
  CAPABILITY_ROUTER_MIN_SCORE: z.coerce.number().min(0).max(1).catch(0.15),
  CAPABILITY_ROUTER_TIMEOUT_MS: timeout.catch(25),
  CAPABILITY_ROUTER_FALLBACK_HARD_CAP: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .catch(100),
  AI_STEP_TIMEOUT_MS: timeout.catch(30_000),
  MCP_MAX_TOTAL_TIMEOUT: timeout.nullish().catch(null),
});

const env = staticConfigSchema.parse(process.env);

export const STATIC_APP_CONFIG = {
  auth: {
    baseUrl: env.BETTER_AUTH_URL ?? null,
  },
  users: {
    defaultRole: env.DEFAULT_USER_ROLE,
  },
  exa: {
    baseUrl: env.EXA_BASE_URL,
  },
  memory: {
    curatorMode: env.IRIS_MEMORY_CURATOR_MODE,
  },
  capabilityRouter: {
    threshold: env.CAPABILITY_ROUTER_THRESHOLD,
    topN: env.CAPABILITY_ROUTER_TOP_N,
    minScore: env.CAPABILITY_ROUTER_MIN_SCORE,
    timeoutMs: env.CAPABILITY_ROUTER_TIMEOUT_MS,
    fallbackHardCap: env.CAPABILITY_ROUTER_FALLBACK_HARD_CAP,
  },
  ai: {
    stepTimeoutMs: env.AI_STEP_TIMEOUT_MS,
  },
  mcp: {
    maxTotalTimeoutMs: env.MCP_MAX_TOTAL_TIMEOUT ?? null,
  },
};
