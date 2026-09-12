import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, type LanguageModel, tool } from "ai";
import {
  SUBAGENT_TOOL_ALLOWLIST,
  selectSubagentTools,
} from "lib/ai/tools/subagent/definitions";
import { createSpawnSubagentTool } from "lib/ai/tools/subagent/spawn-subagent";
import type { AgentRuntimeContext } from "lib/ai/agent/runtime-context";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * LLM-as-a-judge eval for the spawn_subagent tool.
 *
 * Opt-in: requires OPENAI_API_KEY and IRIS_RUN_LLM_JUDGE=1, e.g.
 *   IRIS_RUN_LLM_JUDGE=1 OPENAI_API_KEY=sk-... pnpm vitest run \
 *     src/lib/ai/tools/subagent/spawn-subagent.judge.test.ts
 *
 * The subagent runs against a stubbed webSearch tool with two verifiable
 * facts, then a judge model scores the produced artifact report against a
 * rubric (grounding, structure, summary quality) and checks the exact facts.
 */

const RUN = process.env.IRIS_RUN_LLM_JUDGE === "1" && process.env.OPENAI_API_KEY;

const STUB_SOURCES = [
  {
    title: "Eiffel Tower facts",
    url: "https://example.test/eiffel-tower",
    snippet:
      "The Eiffel Tower in Paris is 330 meters tall including antennas. It was completed in 1889.",
  },
  {
    title: "Paris landmarks",
    url: "https://example.test/paris",
    snippet:
      "Paris landmarks include the Louvre, Notre-Dame, and the Eiffel Tower, built for the 1889 World's Fair.",
  },
];

function judgeModel(): LanguageModel {
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const modelId = process.env.IRIS_JUDGE_MODEL ?? "gpt-4o-mini";
  return openai(modelId);
}

function runtimeContext(): AgentRuntimeContext {
  return {
    requestId: "judge-request",
    runId: "judge-run",
    userId: "judge-user",
    agentType: "base",
    toolMode: "auto",
    approvalPolicy: "never",
    skills: [],
  } as AgentRuntimeContext;
}

async function runSpawnTool(model: LanguageModel) {
  const artifacts = {
    create: vi.fn(async (input: { content: string; filename: string }) => ({
      artifactId: "judge-artifact",
      filename: input.filename,
      mediaType: "text/markdown",
      size: input.content.length,
    })),
  };
  const stubSearch = tool({
    description: "Search the web. Returns snippets.",
    inputSchema: z.object({ query: z.string() }),
    execute: async () => STUB_SOURCES,
  });
  const instance = createSpawnSubagentTool({
    model,
    runtimeContext: runtimeContext(),
    artifacts,
    parentTools: { webSearch: stubSearch },
  });

  const generator = (instance.execute as any)(
    {
      subagent: "research",
      title: "Eiffel Tower Research",
      task: "Use the webSearch tool to find the exact height of the Eiffel Tower and the year it was completed, then write a concise research report citing the sources you used.",
    },
    { toolCallId: "judge-call-1", messages: [] },
  );
  let result = await generator.next();
  while (!result.done) result = await generator.next();
  return { final: result.value, artifacts };
}

describe.runIf(RUN)("spawn_subagent LLM-as-judge eval", () => {
  it(
    "produces a grounded, structured report artifact that passes the judge rubric",
    { timeout: 240_000 },
    async () => {
      const model = judgeModel();
      const { final, artifacts } = await runSpawnTool(model);

      // Structural contract first (non-judged, deterministic).
      expect(final.status).toBe("completed");
      expect(final.report.length).toBeGreaterThan(80);
      expect(artifacts.create).toHaveBeenCalledTimes(1);
      expect(final.artifact).toMatchObject({
        artifactId: "judge-artifact",
        mediaType: "text/markdown",
      });
      const webSearchStub = {
        type: "function" as const,
        inputSchema: z.object({ query: z.string() }),
      };
      expect(
        Object.keys(selectSubagentTools({ webSearch: webSearchStub })).length,
      ).toBe(1);
      expect(SUBAGENT_TOOL_ALLOWLIST.length).toBeGreaterThan(0);

      // Exact facts from the stub sources must survive into the report.
      expect(final.report).toContain("330");
      expect(final.report).toContain("1889");

      // Judged rubric.
      const { object: verdict } = await generateObject({
        model: judgeModel(),
        schema: z.object({
          grounded: z
            .boolean()
            .describe("Every factual claim traces to a cited source."),
          citesSources: z.boolean(),
          isMarkdown: z.boolean(),
          selfContained: z
            .boolean()
            .describe("A reader without the conversation understands it."),
          relevance: z.number().min(1).max(5),
          structure: z.number().min(1).max(5),
          overall: z.number().min(1).max(5),
          comments: z.string(),
        }),
        prompt: `You are judging an AI subagent's research report. The subagent could use a stub webSearch tool returning exactly these two snippets:\n\n${JSON.stringify(
          STUB_SOURCES,
          null,
          2,
        )}\n\nThe task was: "Find the exact height of the Eiffel Tower and the year it was completed, then write a concise research report citing the sources used."\n\nReport to judge:\n\n<report>\n${final.report}\n</report>\n\nScore strictly.`,
      });

      expect(verdict.grounded, verdict.comments).toBe(true);
      expect(verdict.citesSources, verdict.comments).toBe(true);
      expect(verdict.isMarkdown, verdict.comments).toBe(true);
      expect(verdict.selfContained, verdict.comments).toBe(true);
      expect(verdict.relevance, verdict.comments).toBeGreaterThanOrEqual(4);
      expect(verdict.structure, verdict.comments).toBeGreaterThanOrEqual(4);
      expect(verdict.overall, verdict.comments).toBeGreaterThanOrEqual(4);
    },
  );
});
