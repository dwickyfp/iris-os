import { describe, expect, test } from "vitest";
import { GoalRequirementResolver } from "./goal-requirement-resolver";

describe("GoalRequirementResolver", () => {
  const resolver = new GoalRequirementResolver();

  test("defaults ordinary chat to cheap execution verification", () => {
    expect(resolver.resolve({ goal: "How are you today?" })).toEqual({
      goal: "How are you today?",
      level: "execution",
      requiredArtifactKinds: [],
      requiredMediaTypes: [],
      requiredSections: [],
      requiredCapabilities: [],
      analysisOnlyAllowed: false,
    });
  });

  test("normalizes a Q2 revenue PDF report deterministically", () => {
    expect(
      resolver.resolve({
        goal: "create Q2 revenue PDF report",
        selectedCapabilities: ["generate_report", "webSearch"],
      }),
    ).toEqual({
      goal: "create Q2 revenue PDF report",
      level: "artifact",
      requiredArtifactKinds: ["report"],
      requiredMediaTypes: ["application/pdf"],
      requiredPeriod: "Q2",
      requiredSections: [],
      requiredCapabilities: ["analysis", "generate_report"],
      analysisOnlyAllowed: false,
    });
  });

  test("uses outcome verification for an explicit analysis goal", () => {
    expect(resolver.resolve({ goal: "Analyze Q2 revenue trends" })).toEqual({
      goal: "Analyze Q2 revenue trends",
      level: "outcome",
      requiredArtifactKinds: [],
      requiredMediaTypes: [],
      requiredSections: [],
      requiredCapabilities: ["analysis"],
      analysisOnlyAllowed: true,
    });
  });

  test("extracts only explicit title and sections", () => {
    expect(
      resolver.resolve({
        goal:
          'Generate a markdown report titled "Revenue Review" with sections Summary, Risks and Recommendations.',
      }),
    ).toMatchObject({
      requiredTitle: "Revenue Review",
      requiredSections: ["Summary", "Risks", "Recommendations"],
      requiredMediaTypes: ["text/markdown"],
    });
  });

  test("extracts an explicit unquoted title", () => {
    expect(
      resolver.resolve({
        goal: "Create a report titled Q2 Revenue Review with sections Summary",
      }).requiredTitle,
    ).toBe("Q2 Revenue Review");
  });
});
