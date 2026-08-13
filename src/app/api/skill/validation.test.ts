import { describe, expect, it } from "vitest";
import {
  AgentSkillsUpdateSchema,
  MAX_SKILL_ASSIGNMENTS,
  MAX_SKILL_FILE_SIZE,
  SkillFileUpsertSchema,
  SkillRouteCreateSchema,
  SkillRouteUpdateSchema,
  parseSkillFilePath,
} from "./validation";

describe("skill route validation", () => {
  it("does not accept a client-selected owner", () => {
    const parsed = SkillRouteCreateSchema.parse({
      name: "research",
      description: "Research helpers",
      body: "Instructions",
      userId: "another-user",
    });
    expect(parsed).not.toHaveProperty("userId");
  });

  it("rejects empty updates", () => {
    expect(SkillRouteUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("decodes and validates catch-all file paths", () => {
    expect(parseSkillFilePath(["references", "API%20guide.md"])).toBe(
      "references/API guide.md",
    );
    expect(() => parseSkillFilePath(["references", "..", "secret"])).toThrow();
  });

  it("limits individual file content by UTF-8 bytes", () => {
    expect(
      SkillFileUpsertSchema.safeParse({
        content: "a".repeat(MAX_SKILL_FILE_SIZE + 1),
        mimeType: "text/plain",
        size: MAX_SKILL_FILE_SIZE + 1,
      }).success,
    ).toBe(false);
  });

  it("requires unique, bounded ordered agent assignments", () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect(
      AgentSkillsUpdateSchema.safeParse({ skillIds: [id, id] }).success,
    ).toBe(false);
    expect(
      AgentSkillsUpdateSchema.safeParse({
        skillIds: Array.from(
          { length: MAX_SKILL_ASSIGNMENTS + 1 },
          (_, index) =>
            `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        ),
      }).success,
    ).toBe(false);
  });
});
