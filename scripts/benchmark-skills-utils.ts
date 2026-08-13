import type { AssignedSkill } from "../src/lib/ai/skill/types";

export const SKILL_COUNTS = [1, 5, 10, 20] as const;
export const BODY_SIZES = [1024, 10 * 1024, 100 * 1024] as const;
export const TOKEN_ESTIMATE_BYTES = 4;

export type TokenComparison = {
  skillCount: number;
  bodyBytes: number;
  progressiveTokens: number;
  eagerTokens: number;
  reductionPercent: number;
};

export type BenchmarkCheck = {
  name: string;
  passed: boolean;
  actual: number | boolean;
  expected: string;
};

export function estimateTokens(value: string): number {
  return Math.ceil(
    new TextEncoder().encode(value).byteLength / TOKEN_ESTIMATE_BYTES,
  );
}

export function createBenchmarkSkills(
  count: number,
  bodyBytes: number,
): AssignedSkill[] {
  return Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return {
      id: `skill-${number}`,
      name: `Benchmark Skill ${number}`,
      description: `Deterministic benchmark metadata for skill ${number}.`,
      body: "x".repeat(bodyBytes),
      files: [],
    };
  });
}

export function compareProgressiveAndEagerTokens({
  skills,
  manifestPrompt,
}: {
  skills: AssignedSkill[];
  manifestPrompt: string;
}): TokenComparison {
  const first = skills[0];
  if (!first) throw new Error("At least one benchmark skill is required");

  const progressivePayload = `${manifestPrompt}\n${JSON.stringify({
    skill: {
      id: first.id,
      name: first.name,
      description: first.description,
    },
    content: first.body,
    resources: [],
    alreadyLoaded: false,
  })}`;
  const eagerPayload = JSON.stringify(
    skills.map(({ id, name, description, body, files }) => ({
      id,
      name,
      description,
      body,
      files,
    })),
  );
  const progressiveTokens = estimateTokens(progressivePayload);
  const eagerTokens = estimateTokens(eagerPayload);

  return {
    skillCount: skills.length,
    bodyBytes: first.body.length,
    progressiveTokens,
    eagerTokens,
    reductionPercent: ((eagerTokens - progressiveTokens) / eagerTokens) * 100,
  };
}

export function buildSemanticChecks({
  manifestPrompt,
  listPayload,
  cachedViewPayload,
  tokenComparisons,
}: {
  manifestPrompt: string;
  listPayload: string;
  cachedViewPayload: string;
  tokenComparisons: TokenComparison[];
}): BenchmarkCheck[] {
  const reductions = [
    { count: 5, minimum: 50 },
    { count: 10, minimum: 75 },
    { count: 20, minimum: 80 },
  ];

  return [
    {
      name: "manifest excludes skill bodies",
      passed: !manifestPrompt.includes("x".repeat(64)),
      actual: !manifestPrompt.includes("x".repeat(64)),
      expected: "true",
    },
    {
      name: "skills_list excludes skill bodies",
      passed: !listPayload.includes("x".repeat(64)),
      actual: !listPayload.includes("x".repeat(64)),
      expected: "true",
    },
    {
      name: "cached skill_view excludes loaded content",
      passed: !cachedViewPayload.includes("x".repeat(64)),
      actual: !cachedViewPayload.includes("x".repeat(64)),
      expected: "true",
    },
    ...reductions.map(({ count, minimum }) => {
      const matching = tokenComparisons.filter(
        (comparison) => comparison.skillCount === count,
      );
      const actual = Math.min(
        ...matching.map((comparison) => comparison.reductionPercent),
      );
      return {
        name: `${count}-skill progressive token reduction`,
        passed: matching.length > 0 && actual >= minimum,
        actual: Number(actual.toFixed(2)),
        expected: `>= ${minimum}% for every body size`,
      };
    }),
  ];
}
