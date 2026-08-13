import "load-env";

import { generateText, isStepCount } from "ai";
import { buildSkillManifestPrompt } from "../src/lib/ai/skill/manifest";
import { createSkillsRuntime } from "../src/lib/ai/skill/runtime";
import type { AssignedSkillsRepository } from "../src/lib/ai/skill/types";
import {
  type ActivationScore,
  type AnswerScore,
  scoreSkillActivation,
  scoreSkillAnswer,
  summarizeSkillEval,
} from "../src/lib/ai/skill/evaluation";
import {
  loadSkillEvalFixture,
  skip,
  writeSkillReport,
} from "./skills-benchmark-shared";

async function main() {
  if (process.env.SKILLS_LIVE_BENCHMARK !== "1") {
    skip("set SKILLS_LIVE_BENCHMARK=1 to run live Skills evaluation");
    return;
  }
  if (!process.env.POSTGRES_URL) {
    skip("POSTGRES_URL is unavailable; Admin Model Settings cannot be loaded");
    return;
  }

  const fixture = await loadSkillEvalFixture();
  let model: Awaited<
    ReturnType<
      typeof import("../src/lib/ai/models")["customModelProvider"]["getModel"]
    >
  >;
  let modelInfo: { provider: string; model: string };
  try {
    const { customModelProvider } = await import("../src/lib/ai/models");
    const configuration = await customModelProvider.getModelConfiguration();
    if (!configuration.capabilities.toolCalls) {
      skip("the configured Admin default model does not support tool calls");
      return;
    }
    if (
      configuration.providerType !== "ollama" &&
      !configuration.encryptedApiKey
    ) {
      skip("the configured Admin model provider has no stored API credential");
      return;
    }
    model = await customModelProvider.getModel();
    modelInfo = {
      provider: configuration.provider,
      model: configuration.model,
    };
  } catch {
    skip(
      "Admin Model Settings are unavailable; verify DB access, migrations, model configuration, and MODEL_SETTINGS_ENCRYPTION_KEY",
    );
    return;
  }

  const repository: AssignedSkillsRepository = {
    selectSkillsByAgentId: async () => fixture.skills,
    selectSkillById: async (skillId) =>
      fixture.skills.find((skill) => skill.id === skillId) ?? null,
  };
  const results: Array<{
    id: string;
    kind: "activation" | "answer";
    prompt: string;
    answer: string;
    activatedSkillIds: string[];
    activation: ActivationScore;
    answerScore?: AnswerScore;
    judgeRubric?: string;
  }> = [];
  try {
    for (const testCase of fixture.cases) {
      const runtime = await createSkillsRuntime({
        repository,
        agentId: "skills-live-benchmark",
        userId: "skills-live-benchmark",
      });
      const response = await generateText({
        model,
        instructions: buildSkillManifestPrompt(runtime.manifest),
        prompt: testCase.prompt,
        tools: runtime.tools,
        stopWhen: isStepCount(6),
        temperature: 0,
      });
      const activatedSkillIds = response.steps.flatMap((step) =>
        step.toolCalls.flatMap((call) => {
          if (call.toolName !== "skill_view") return [];
          const input = call.input as { skillId?: unknown };
          return typeof input.skillId === "string" ? [input.skillId] : [];
        }),
      );
      results.push({
        id: testCase.id,
        kind: testCase.kind,
        prompt: testCase.prompt,
        answer: response.text,
        activatedSkillIds: [...new Set(activatedSkillIds)],
        activation: scoreSkillActivation(
          testCase.expectedSkillIds,
          activatedSkillIds,
        ),
        answerScore: scoreSkillAnswer(response.text, testCase.answer),
        judgeRubric: testCase.judgeRubric,
      });
    }
  } catch {
    skip(
      "the configured Admin model request failed; verify its endpoint and API credentials (no fallback was attempted)",
    );
    return;
  }

  const report = {
    schemaVersion: 1,
    benchmark: "skills-live",
    createdAt: new Date().toISOString(),
    model: modelInfo,
    summary: summarizeSkillEval(
      results.map((result) => ({
        activation: result.activation,
        answer: result.answerScore,
      })),
    ),
    results,
  };
  const path = await writeSkillReport("live", report);
  console.log(`Skills live benchmark report: ${path}`);
  console.log(JSON.stringify(report.summary));
}

await main();
