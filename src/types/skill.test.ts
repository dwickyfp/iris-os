import { describe, expect, it } from "vitest";
import {
  MAX_SKILL_BODY_SIZE,
  MAX_SKILL_FILES,
  SkillCreateSchema,
  SkillFilePathSchema,
  SkillNameSchema,
  SkillUpdateSchema,
} from "./skill";

describe("Skill schemas", () => {
  it.each([
    "references/api.md",
    "scripts/setup.sh",
    "assets/example.json",
    "templates/report.md",
  ])("accepts a safe skill file path: %s", (path) => {
    expect(SkillFilePathSchema.safeParse(path).success).toBe(true);
  });

  it.each([
    "SKILL.md",
    "/references/api.md",
    "references/../secret",
    "references\\api.md",
    "scripts",
    "other/file.txt",
  ])("rejects an unsafe or unsupported skill file path: %s", (path) => {
    expect(SkillFilePathSchema.safeParse(path).success).toBe(false);
  });

  it("defaults new skills to private with no supplemental files", () => {
    const skill = SkillCreateSchema.parse({
      name: "research",
      description: "Research workflow",
      userId: "user-1",
      body: "Use this skill for research.",
    });

    expect(skill.visibility).toBe("private");
    expect(skill.files).toEqual([]);
  });

  it("does not permit public visibility", () => {
    expect(SkillUpdateSchema.safeParse({ visibility: "public" }).success).toBe(
      false,
    );
  });

  it("rejects duplicate supplemental file paths", () => {
    expect(
      SkillCreateSchema.safeParse({
        name: "research",
        description: "Research workflow",
        userId: "user-1",
        body: "Instructions",
        files: [
          {
            path: "references/api.md",
            content: "one",
            mimeType: "text/markdown",
            size: 3,
          },
          {
            path: "references/api.md",
            content: "two",
            mimeType: "text/markdown",
            size: 3,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it.each(["a", "research-2", "a1-b2-c3"])(
    "accepts an Agent Skills name: %s",
    (name) => {
      expect(SkillNameSchema.safeParse(name).success).toBe(true);
    },
  );

  it.each(["Research", "-research", "research-", "research--tool", "a_b"])(
    "rejects a non-compliant Agent Skills name: %s",
    (name) => {
      expect(SkillNameSchema.safeParse(name).success).toBe(false);
    },
  );

  it("requires a bounded description and non-empty bounded body", () => {
    const base = { name: "research", userId: "user-1" };
    expect(SkillCreateSchema.safeParse({ ...base, body: "body" }).success).toBe(
      false,
    );
    expect(
      SkillCreateSchema.safeParse({
        ...base,
        description: "description",
        body: "x".repeat(MAX_SKILL_BODY_SIZE + 1),
      }).success,
    ).toBe(false);
    expect(
      SkillCreateSchema.safeParse({
        ...base,
        description: "description",
        body: "é".repeat(MAX_SKILL_BODY_SIZE / 2 + 1),
      }).success,
    ).toBe(false);
  });

  it("enforces file count and UTF-8 size", () => {
    const file = {
      path: "references/file.md",
      content: "é",
      mimeType: "text/markdown",
      size: 1,
    };
    expect(
      SkillCreateSchema.safeParse({
        name: "research",
        description: "description",
        userId: "user-1",
        body: "body",
        files: [file],
      }).success,
    ).toBe(false);

    expect(
      SkillCreateSchema.safeParse({
        name: "research",
        description: "description",
        userId: "user-1",
        body: "body",
        files: Array.from({ length: MAX_SKILL_FILES + 1 }, (_, index) => ({
          path: `references/${index}.md`,
          content: "",
          mimeType: "text/markdown",
          size: 0,
        })),
      }).success,
    ).toBe(false);
  });
});
