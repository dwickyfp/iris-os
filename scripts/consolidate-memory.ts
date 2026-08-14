import "load-env";
import { z } from "zod";
import { enqueueMemoryConsolidation } from "lib/ai/memory/queue";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const InputSchema = z
  .object({
    userId: z.string().uuid(),
    scopeType: z
      .enum(["global", "workspace", "task", "agent"])
      .default("global"),
    scopeId: z.string().uuid().optional(),
    mode: z.enum(["shadow", "write"]).default("shadow"),
  })
  .superRefine((input, context) => {
    if (input.scopeType === "global" && input.scopeId)
      context.addIssue({
        code: "custom",
        path: ["scopeId"],
        message: "Global consolidation cannot have a scope ID",
      });
    if (input.scopeType !== "global" && !input.scopeId)
      context.addIssue({
        code: "custom",
        path: ["scopeId"],
        message: `${input.scopeType} consolidation requires a scope ID`,
      });
  });

const input = InputSchema.parse({
  userId: argument("--user"),
  scopeType: argument("--scope-type"),
  scopeId: argument("--scope-id"),
  mode: argument("--mode"),
});

await enqueueMemoryConsolidation({
  id: `${input.userId}:${input.scopeType}:${input.scopeId ?? "global"}:${input.mode}`,
  ...input,
});

console.info(
  `Queued ${input.mode} memory consolidation for ${input.userId} (${input.scopeType}:${input.scopeId ?? "global"})`,
);
