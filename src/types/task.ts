import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "planned",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
]);
export const TaskPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);

export const TaskCreateSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  parentTaskId: z.string().uuid().optional(),
  assignedAgentId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(4_000).optional(),
  priority: TaskPrioritySchema.default("normal"),
  nextAction: z.string().trim().max(2_000).optional(),
  dueAt: z.coerce.date().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const TaskUpdateSchema = TaskCreateSchema.partial()
  .extend({
    status: TaskStatusSchema.optional(),
    checkpoint: z.string().trim().max(20_000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "No changes supplied");

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;
export type TaskCreateInput = z.input<typeof TaskCreateSchema>;
export type TaskCreateData = z.output<typeof TaskCreateSchema>;
export type TaskUpdateInput = z.input<typeof TaskUpdateSchema>;
export type TaskUpdateData = z.output<typeof TaskUpdateSchema>;
export type ResourceRefCreateData = z.output<typeof ResourceRefCreateSchema>;

export type IrisTask = TaskCreateData & {
  id: string;
  userId: string;
  status: TaskStatus;
  checkpoint?: string;
  startedAt?: Date;
  blockedAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export const ResourceKindSchema = z.enum([
  "thread",
  "file",
  "artifact",
  "workflow_run",
  "tool_run",
  "repository",
  "url",
  "decision",
]);

export const ResourceRefCreateSchema = z.object({
  kind: ResourceKindSchema,
  referenceId: z.string().trim().min(1).max(2_000),
  label: z.string().trim().max(240).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
