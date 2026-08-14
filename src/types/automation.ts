import { z } from "zod";

export const AutomationCreateSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(160),
  triggerType: z.enum(["manual", "schedule"]),
  cron: z.string().trim().min(5).max(120).optional(),
  timezone: z.string().trim().min(1).max(80).default("UTC"),
  missedRunPolicy: z.enum(["skip", "run_once"]).default("skip"),
  targetType: z.enum(["workflow", "skill", "agent"]),
  targetId: z.string().uuid(),
  approvalPolicy: z.enum(["always", "destructive_only", "never"]),
  input: z.record(z.string(), z.unknown()).default({}),
  retryLimit: z.number().int().min(0).max(20).default(3),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
});

export const AutomationUpdateSchema = AutomationCreateSchema.partial().extend({
  status: z.enum(["active", "paused", "archived"]).optional(),
});

export type AutomationCreateData = z.output<typeof AutomationCreateSchema>;
