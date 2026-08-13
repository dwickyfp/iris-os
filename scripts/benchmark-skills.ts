import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSkillManifestPrompt,
  createSkillManifest,
} from "../src/lib/ai/skill/manifest";
import { createSkillsRuntime } from "../src/lib/ai/skill/runtime";
import type {
  AssignedSkill,
  AssignedSkillsRepository,
} from "../src/lib/ai/skill/types";
import {
  BODY_SIZES,
  type BenchmarkCheck,
  buildSemanticChecks,
  compareProgressiveAndEagerTokens,
  createBenchmarkSkills,
  estimateTokens,
  SKILL_COUNTS,
  TOKEN_ESTIMATE_BYTES,
  type TokenComparison,
} from "./benchmark-skills-utils";

const ITERATIONS = 100;
const WARMUP_ITERATIONS = 10;
const LATENCY_CEILING_MS = 1_000;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDirectory = resolve(projectRoot, "benchmark-results");

type LatencyResult = {
  operation: string;
  iterations: number;
  medianMs: number;
  p95Ms: number;
};

function createRepository(skills: AssignedSkill[]): AssignedSkillsRepository {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  return {
    async selectSkillsByAgentId() {
      return skills;
    },
    async selectSkillById(skillId) {
      return byId.get(skillId) ?? null;
    },
    async selectSkillSummariesByAgentId(_agentId, _userId, limit) {
      return skills.slice(0, limit).map(({ id, name, description }) => ({
        id,
        name,
        description,
      }));
    },
    async selectSkillContentById(skillId) {
      const skill = byId.get(skillId);
      return skill ? { body: skill.body, resources: [] } : null;
    },
  };
}

async function executeTool(
  runtime: Awaited<ReturnType<typeof createSkillsRuntime>>,
  toolName: "skills_list" | "skill_view",
  input: unknown,
) {
  return runtime.tools[toolName].execute!(input, {} as never);
}

async function measure(
  operation: string,
  run: () => unknown | Promise<unknown>,
): Promise<LatencyResult> {
  for (let index = 0; index < WARMUP_ITERATIONS; index++) await run();
  const samples: number[] = [];
  for (let index = 0; index < ITERATIONS; index++) {
    const startedAt = performance.now();
    await run();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);

  return {
    operation,
    iterations: ITERATIONS,
    medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(3)),
    p95Ms: Number(samples[Math.floor(samples.length * 0.95)].toFixed(3)),
  };
}

function formatHumanReport(report: {
  manifestTokens: number;
  latencies: LatencyResult[];
  tokenComparisons: TokenComparison[];
  checks: BenchmarkCheck[];
}) {
  const lines = [
    "Skills benchmark",
    "================",
    `Estimator: ceil(UTF-8 bytes / ${TOKEN_ESTIMATE_BYTES})`,
    `Iterations: ${ITERATIONS} measured, ${WARMUP_ITERATIONS} warmup`,
    `20-skill manifest estimate: ${report.manifestTokens} tokens`,
    "",
    "Latency (informational; broad hang guard only)",
    "Operation                         median ms    p95 ms",
    ...report.latencies.map(
      (result) =>
        `${result.operation.padEnd(33)} ${result.medianMs
          .toFixed(3)
          .padStart(9)} ${result.p95Ms.toFixed(3).padStart(10)}`,
    ),
    "",
    "Progressive loading vs eager injection",
    "skills  body bytes  progressive  eager  reduction",
    ...report.tokenComparisons.map(
      (result) =>
        `${String(result.skillCount).padStart(6)} ${String(
          result.bodyBytes,
        ).padStart(11)} ${String(result.progressiveTokens).padStart(
          12,
        )} ${String(result.eagerTokens).padStart(6)} ${`${result.reductionPercent.toFixed(2)}%`.padStart(10)}`,
    ),
    "",
    "Checks",
    ...report.checks.map(
      (check) =>
        `${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.actual} (expected ${check.expected})`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

async function main() {
  const largestSkills = createBenchmarkSkills(20, 100 * 1024);
  const manifest = createSkillManifest(largestSkills);
  const manifestPrompt = buildSkillManifestPrompt(manifest)!;
  const repository = createRepository(largestSkills);
  const runtime = await createSkillsRuntime({
    repository,
    agentId: "benchmark-agent",
    userId: "benchmark-user",
  });
  const firstSkillId = largestSkills[0].id;

  const latencies: LatencyResult[] = [];
  latencies.push(
    await measure("manifest build", () => {
      buildSkillManifestPrompt(createSkillManifest(largestSkills));
    }),
  );
  latencies.push(
    await measure("skills_list", () =>
      executeTool(runtime, "skills_list", { query: "benchmark" }),
    ),
  );
  latencies.push(
    await measure("skill_view cold", async () => {
      const coldRuntime = await createSkillsRuntime({
        repository,
        agentId: "benchmark-agent",
        userId: "benchmark-user",
      });
      await executeTool(coldRuntime, "skill_view", { skillId: firstSkillId });
    }),
  );
  await executeTool(runtime, "skill_view", { skillId: firstSkillId });
  latencies.push(
    await measure("skill_view cached", () =>
      executeTool(runtime, "skill_view", { skillId: firstSkillId }),
    ),
  );

  const listPayload = JSON.stringify(
    await executeTool(runtime, "skills_list", {}),
  );
  const cachedViewPayload = JSON.stringify(
    await executeTool(runtime, "skill_view", { skillId: firstSkillId }),
  );
  const tokenComparisons = BODY_SIZES.flatMap((bodyBytes) =>
    SKILL_COUNTS.map((skillCount) => {
      const skills = createBenchmarkSkills(skillCount, bodyBytes);
      const prompt = buildSkillManifestPrompt(createSkillManifest(skills))!;
      return compareProgressiveAndEagerTokens({
        skills,
        manifestPrompt: prompt,
      });
    }),
  );
  const semanticChecks = buildSemanticChecks({
    manifestPrompt,
    listPayload,
    cachedViewPayload,
    tokenComparisons,
  });
  const latencyChecks: BenchmarkCheck[] = latencies.map((latency) => ({
    name: `${latency.operation} completes without hanging`,
    passed: latency.p95Ms < LATENCY_CEILING_MS,
    actual: latency.p95Ms,
    expected: `< ${LATENCY_CEILING_MS}ms p95`,
  }));
  const checks = [...semanticChecks, ...latencyChecks];
  const report = {
    benchmark: "skills-progressive-loading",
    version: 1,
    configuration: {
      skillCounts: SKILL_COUNTS,
      bodySizes: BODY_SIZES,
      iterations: ITERATIONS,
      warmupIterations: WARMUP_ITERATIONS,
      tokenEstimateUtf8BytesPerToken: TOKEN_ESTIMATE_BYTES,
      latencyCeilingMs: LATENCY_CEILING_MS,
    },
    manifestTokens: estimateTokens(manifestPrompt),
    latencies,
    tokenComparisons,
    checks,
    passed: checks.every((check) => check.passed),
  };
  const humanReport = formatHumanReport(report);

  await mkdir(artifactDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(artifactDirectory, "skills-benchmark.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    ),
    writeFile(resolve(artifactDirectory, "skills-benchmark.txt"), humanReport),
  ]);
  process.stdout.write(humanReport);
  process.stdout.write(`Artifacts: ${artifactDirectory}\n`);

  if (!report.passed) process.exitCode = 1;
}

await main();
