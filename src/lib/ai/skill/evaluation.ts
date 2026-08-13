import { z } from "zod";

export const SkillEvalFixtureSchema = z.object({
  skills: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().optional(),
      body: z.string().min(1),
      files: z
        .array(z.object({ path: z.string().min(1), content: z.string() }))
        .default([]),
    }),
  ),
  cases: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.enum(["activation", "answer"]),
      prompt: z.string().min(1),
      expectedSkillIds: z.array(z.string()).default([]),
      answer: z
        .object({
          requiredAny: z.array(z.array(z.string().min(1)).min(1)).default([]),
          forbidden: z.array(z.string().min(1)).default([]),
        })
        .optional(),
      judgeRubric: z.string().optional(),
    }),
  ),
});

export type SkillEvalFixture = z.infer<typeof SkillEvalFixtureSchema>;
export type SkillEvalCase = SkillEvalFixture["cases"][number];

export type ActivationScore = {
  expected: string[];
  actual: string[];
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  exact: boolean;
};

export type AnswerScore = {
  matchedRequired: number;
  required: number;
  forbiddenMatches: string[];
  score: number;
  pass: boolean;
};

function normalized(value: string) {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

export function scoreSkillActivation(
  expectedSkillIds: string[],
  actualSkillIds: string[],
): ActivationScore {
  const expected = [...new Set(expectedSkillIds)].sort();
  const actual = [...new Set(actualSkillIds)].sort();
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const truePositives = actual.filter((id) => expectedSet.has(id)).length;
  const falsePositives = actual.filter((id) => !expectedSet.has(id)).length;
  const falseNegatives = expected.filter((id) => !actualSet.has(id)).length;

  return {
    expected,
    actual,
    truePositives,
    falsePositives,
    falseNegatives,
    precision:
      actual.length === 0
        ? expected.length === 0
          ? 1
          : 0
        : truePositives / actual.length,
    recall: expected.length === 0 ? 1 : truePositives / expected.length,
    exact: falsePositives === 0 && falseNegatives === 0,
  };
}

export function scoreSkillAnswer(
  answer: string,
  expectation?: SkillEvalCase["answer"],
): AnswerScore | undefined {
  if (!expectation) return undefined;
  const value = normalized(answer);
  const matchedRequired = expectation.requiredAny.filter((alternatives) =>
    alternatives.some((candidate) => value.includes(normalized(candidate))),
  ).length;
  const forbiddenMatches = expectation.forbidden.filter((candidate) =>
    value.includes(normalized(candidate)),
  );
  const requiredScore = expectation.requiredAny.length
    ? matchedRequired / expectation.requiredAny.length
    : 1;
  const score = forbiddenMatches.length ? 0 : requiredScore;

  return {
    matchedRequired,
    required: expectation.requiredAny.length,
    forbiddenMatches,
    score,
    pass: score === 1,
  };
}

export function summarizeSkillEval(
  results: Array<{
    activation: ActivationScore;
    answer?: AnswerScore;
  }>,
) {
  const answerResults = results.flatMap((result) =>
    result.answer ? [result.answer] : [],
  );
  return {
    cases: results.length,
    activationExact: results.filter((result) => result.activation.exact).length,
    activationExactRate: results.length
      ? results.filter((result) => result.activation.exact).length /
        results.length
      : 0,
    answerCases: answerResults.length,
    answerPass: answerResults.filter((result) => result.pass).length,
    answerPassRate: answerResults.length
      ? answerResults.filter((result) => result.pass).length /
        answerResults.length
      : 0,
  };
}
