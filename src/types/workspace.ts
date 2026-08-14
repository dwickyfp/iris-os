import { z } from "zod";

export const WorkspaceStatusSchema = z.enum(["active", "archived"]);
export const WorkspaceToolModeSchema = z.enum(["auto", "manual", "none"]);

const WorkspaceFieldsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().max(2_000).optional(),
  instructions: z.string().trim().max(20_000).optional(),
  defaultModelId: z.string().uuid().optional(),
  defaultAgentId: z.string().uuid().optional(),
  defaultToolMode: WorkspaceToolModeSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const WorkspaceCreateSchema = WorkspaceFieldsSchema.extend({
  defaultToolMode: WorkspaceToolModeSchema.default("auto"),
});

export const WorkspaceUpdateSchema = WorkspaceFieldsSchema.extend({
  status: WorkspaceStatusSchema,
})
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one workspace field must be updated",
  });

export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
export type WorkspaceToolMode = z.infer<typeof WorkspaceToolModeSchema>;
export type WorkspaceCreateInput = z.input<typeof WorkspaceCreateSchema>;
export type WorkspaceCreateData = z.output<typeof WorkspaceCreateSchema>;
export type WorkspaceUpdateInput = z.infer<typeof WorkspaceUpdateSchema>;

export type Workspace = WorkspaceCreateData & {
  id: string;
  userId: string;
  status: WorkspaceStatus;
  createdAt: Date;
  updatedAt: Date;
};
