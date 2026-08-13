import { describe, expect, it } from "vitest";
import {
  scoreSkillActivation,
  scoreSkillAnswer,
  summarizeSkillEval,
} from "./evaluation";

describe("skill evaluation scoring", () => {
  it("scores deduplicated activation sets without rewarding false positives", () => {
    expect(
      scoreSkillActivation(["release"], ["release", "release", "other"]),
    ).toEqual({
      expected: ["release"],
      actual: ["other", "release"],
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 0,
      precision: 0.5,
      recall: 1,
      exact: false,
    });
  });

  it("treats an expected non-activation as exact", () => {
    expect(scoreSkillActivation([], [])).toMatchObject({
      precision: 1,
      recall: 1,
      exact: true,
    });
  });

  it("scores required alternatives case-insensitively and rejects forbidden text", () => {
    expect(
      scoreSkillAnswer("RELEASE BRIEF\nVersion 2.4 is stable", {
        requiredAny: [["release brief"], ["2.4", "version 2.4"]],
        forbidden: ["rollback"],
      }),
    ).toMatchObject({ matchedRequired: 2, required: 2, score: 1, pass: true });
    expect(
      scoreSkillAnswer("Release brief: rollback", {
        requiredAny: [["release brief"]],
        forbidden: ["rollback"],
      }),
    ).toMatchObject({ score: 0, pass: false });
  });

  it("summarizes activation and answer cases separately", () => {
    const activation = scoreSkillActivation([], []);
    const answer = scoreSkillAnswer("ok", {
      requiredAny: [["ok"]],
      forbidden: [],
    });
    expect(
      summarizeSkillEval([{ activation }, { activation, answer }]),
    ).toEqual({
      cases: 2,
      activationExact: 2,
      activationExactRate: 1,
      answerCases: 1,
      answerPass: 1,
      answerPassRate: 1,
    });
  });
});
