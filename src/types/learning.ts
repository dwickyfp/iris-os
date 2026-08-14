import { z } from "zod";

export const LearningSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  allowedScopes: z
    .array(z.enum(["global", "workspace", "task", "agent"]))
    .min(1)
    .default(["global", "workspace", "task", "agent"]),
  allowedCategories: z
    .array(z.enum(["memory", "skill", "automation"]))
    .min(1)
    .default(["memory", "skill", "automation"]),
  retentionDays: z.number().int().min(1).max(3_650).default(90),
  autonomyLevel: z.number().int().min(0).max(4).default(1),
});

export const LearningSettingsUpdateSchema = LearningSettingsSchema.partial();
