import {
  MCPRemoteConfigZodSchema,
  MCPStdioConfigZodSchema,
} from "app-types/mcp";
import { z } from "zod";

export const mcpServerUpsertSchema = z.object({
  id: z.string().uuid().optional(),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9\-]+$/, {
      message:
        "Name must contain only alphanumeric characters (A-Z, a-z, 0-9) and hyphens (-)",
    }),
  config: z.union([MCPRemoteConfigZodSchema, MCPStdioConfigZodSchema]),
  visibility: z.enum(["public", "private"]).optional(),
});
