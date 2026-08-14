import {
  isStepCount,
  tool,
  ToolLoopAgent,
  type LanguageModel,
} from "ai";
import { z } from "zod";
import type { MemoryScope } from "app-types/memory";
import {
  buildMemoryReviewerPrompt,
  MEMORY_REVIEWER_INSTRUCTIONS,
  MemoryOperationBatchSchema,
  type MemoryCuratorMode,
  type MemoryOperationBatch,
  type MemorySearchCandidate,
} from "./reviewer";

type ReviewerDependencies = {
  model: LanguageModel;
  search: (query: string) => Promise<MemorySearchCandidate[]>;
  commit: (batch: MemoryOperationBatch) => Promise<{
    stats: Record<string, number>;
    memoryIds: string[];
  }>;
};

export async function runMemoryReviewAgent(input: {
  transcript: Array<{ role: "user" | "assistant"; content: string }>;
  scopes: MemoryScope[];
  mode: MemoryCuratorMode;
  focus?: string;
  dependencies: ReviewerDependencies;
}) {
  let searches = 0;
  let commits = 0;
  let proposal: MemoryOperationBatch = { operations: [] };
  const searchedIds = new Set<string>();
  const startedAt = Date.now();

  const runner = new ToolLoopAgent({
    model: input.dependencies.model,
    instructions: input.focus
      ? `${MEMORY_REVIEWER_INSTRUCTIONS}\n\nSpecial review mode:\n${input.focus}`
      : MEMORY_REVIEWER_INSTRUCTIONS,
    tools: {
      search_memory: tool({
        description:
          "Search only the user's relevant active or pending memory claims across the available owned scopes.",
        inputSchema: z.object({
          query: z.string().min(1).max(500),
        }),
        execute: async ({ query }) => {
          searches += 1;
          const candidates = await input.dependencies.search(query);
          candidates.forEach((candidate) => searchedIds.add(candidate.id));
          return { candidates };
        },
      }),
      commit_memory_operations: tool({
        description:
          "Validate and atomically apply one complete batch of memory operations. Call at most once.",
        inputSchema: MemoryOperationBatchSchema,
        execute: async (batch) => {
          if (commits > 0) throw new Error("Memory batch was already committed");
          const hasMutation = batch.operations.some(
            (operation) => operation.action !== "ignore",
          );
          if (hasMutation && searches === 0)
            throw new Error("Search memory before proposing a mutation");
          commits += 1;
          proposal = batch;
          return input.dependencies.commit(batch);
        },
      }),
    },
    stopWhen: isStepCount(6),
    timeout: 60_000,
    telemetry: { functionId: "memory-background-review" },
  });

  const result = await runner.generate({
    prompt: buildMemoryReviewerPrompt({
      transcript: input.transcript,
      availableScopes: input.scopes,
    }),
    timeout: 60_000,
  });

  return {
    proposal,
    searchedIds,
    stats: {
      searches,
      commits,
      tokens: result.usage.totalTokens ?? 0,
      latencyMs: Date.now() - startedAt,
      shadow: input.mode === "shadow" ? 1 : 0,
    },
  };
}
