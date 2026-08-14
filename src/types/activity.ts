import { z } from "zod";
import { MemoryScopeTypeSchema } from "./memory";

export const ActivityActorTypeSchema = z.enum(["user", "agent", "system"]);
export const ActivityEventInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    actorType: ActivityActorTypeSchema,
    actorId: z.string().max(160).optional(),
    scopeType: MemoryScopeTypeSchema.default("global"),
    scopeId: z.string().uuid().nullable().optional(),
    eventType: z.string().trim().min(1).max(120),
    subjectType: z.string().trim().min(1).max(80),
    subjectId: z.string().trim().max(200).optional(),
    payload: z.record(z.string(), z.unknown()).default({}),
    requestId: z.string().max(160).optional(),
    runId: z.string().max(160).optional(),
    parentRunId: z.string().max(160).optional(),
    threadId: z.string().uuid().optional(),
    taskId: z.string().uuid().optional(),
    agentId: z.string().uuid().optional(),
    idempotencyKey: z.string().min(1).max(240),
  })
  .superRefine((event, context) => {
    if (event.scopeType === "global" && event.scopeId) {
      context.addIssue({
        code: "custom",
        message: "Global scope cannot have an id",
      });
    }
    if (event.scopeType !== "global" && !event.scopeId) {
      context.addIssue({
        code: "custom",
        message: "Scoped event requires scopeId",
      });
    }
  });

export type ActivityEventInput = z.output<typeof ActivityEventInputSchema>;
