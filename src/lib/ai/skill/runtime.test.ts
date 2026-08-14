import { describe, expect, it, vi } from "vitest";
import { bindSkillTools, createSkillsRuntime } from "./runtime";
import {
  type AssignedSkillsRepository,
  MAX_ASSIGNED_SKILLS,
  SKILL_NOT_AVAILABLE,
} from "./types";

const skill = {
  id: "review",
  name: "Code Review",
  description: "Review code safely",
  body: "Full instructions",
  files: [{ path: "references/checklist.md", content: "Checklist" }],
};

function createRepository(): AssignedSkillsRepository {
  return {
    selectSkillsByAgentId: vi.fn(async () => [skill]),
    selectSkillById: vi.fn(async (skillId) =>
      skillId === skill.id ? skill : null,
    ),
  };
}

async function execute(
  runtime: Awaited<ReturnType<typeof createSkillsRuntime>>,
  toolName: "skills_list" | "skill_view",
  input: unknown,
) {
  return runtime.tools[toolName].execute!(input, {} as any);
}

describe("createSkillsRuntime", () => {
  it("prefers assigned metadata and lazily loads full content", async () => {
    const repository = createRepository();
    repository.selectSkillSummariesByAgentId = vi.fn(async () => [
      { id: skill.id, name: skill.name, description: skill.description },
    ]);
    const runtime = await createSkillsRuntime({
      repository,
      agentId: "agent-1",
      userId: "user-1",
    });

    expect(repository.selectSkillsByAgentId).not.toHaveBeenCalled();
    expect(repository.selectSkillById).not.toHaveBeenCalled();
    expect(runtime.manifest).toEqual([
      { id: "review", name: "Code Review", description: "Review code safely" },
    ]);
    await expect(
      execute(runtime, "skill_view", { skillId: "review" }),
    ).resolves.toMatchObject({
      content: "Full instructions",
      resources: ["references/checklist.md"],
      alreadyLoaded: false,
    });
    expect(repository.selectSkillById).toHaveBeenCalledTimes(1);
  });

  it("uses granular content and file methods without loading a full skill", async () => {
    const repository = createRepository();
    repository.selectSkillSummariesByAgentId = vi.fn(async () => [
      { id: skill.id, name: skill.name, description: skill.description },
    ]);
    repository.selectSkillContentById = vi.fn(async () => ({
      body: skill.body,
      resources: skill.files.map((file) => file.path),
    }));
    repository.selectSkillFileByPath = vi.fn(async () => skill.files[0]);
    const runtime = await createSkillsRuntime({
      repository,
      agentId: "agent-1",
      userId: "user-1",
    });

    await execute(runtime, "skill_view", {
      skillId: "review",
      filePath: "references/checklist.md",
    });
    expect(repository.selectSkillById).not.toHaveBeenCalled();
    expect(repository.selectSkillContentById).toHaveBeenCalledTimes(1);
    expect(repository.selectSkillFileByPath).toHaveBeenCalledTimes(1);
  });

  it("searches metadata and reports loaded state", async () => {
    const runtime = await createSkillsRuntime({
      repository: createRepository(),
      agentId: "agent-1",
      userId: "user-1",
    });

    await expect(
      execute(runtime, "skills_list", { query: "missing" }),
    ).resolves.toEqual({ skills: [] });
    await expect(
      execute(runtime, "skills_list", { query: "SAFELY" }),
    ).resolves.toEqual({ skills: [{ ...runtime.manifest[0], loaded: false }] });
    await execute(runtime, "skill_view", { skillId: "review" });
    await expect(execute(runtime, "skills_list", {})).resolves.toEqual({
      skills: [{ ...runtime.manifest[0], loaded: true }],
    });
  });

  it("deduplicates concurrent loads and returns already-loaded responses", async () => {
    const repository = createRepository();
    const runtime = await createSkillsRuntime({
      repository,
      agentId: "agent-1",
      userId: "user-1",
    });

    const responses = await Promise.all([
      execute(runtime, "skill_view", { skillId: "review" }),
      execute(runtime, "skill_view", { skillId: "review" }),
    ]);
    expect(repository.selectSkillById).toHaveBeenCalledTimes(1);
    expect(responses).toContainEqual(
      expect.objectContaining({
        content: "Full instructions",
        alreadyLoaded: false,
      }),
    );
    expect(responses).toContainEqual({
      skillId: "review",
      alreadyLoaded: true,
    });
    await expect(
      execute(runtime, "skill_view", { skillId: "review" }),
    ).resolves.toEqual({ skillId: "review", alreadyLoaded: true });
  });

  it("loads filePath resources and accepts the legacy path field", async () => {
    const runtime = await createSkillsRuntime({
      repository: createRepository(),
      agentId: "agent-1",
      userId: "user-1",
    });

    await expect(
      execute(runtime, "skill_view", {
        skillId: "review",
        filePath: "references/checklist.md",
      }),
    ).resolves.toMatchObject({
      filePath: "references/checklist.md",
      content: "Checklist",
      resources: ["references/checklist.md"],
    });
    await expect(
      execute(runtime, "skill_view", {
        skillId: "review",
        path: "references/checklist.md",
      }),
    ).resolves.toEqual({
      skillId: "review",
      filePath: "references/checklist.md",
      alreadyLoaded: true,
    });
  });

  it.each([
    { skillId: "other" },
    { skillId: "review", filePath: "../secret" },
    { skillId: "review", filePath: "references/missing.md" },
    {
      skillId: "review",
      filePath: "references/checklist.md",
      path: "references/other.md",
    },
  ])("uses a generic error for unavailable views: %j", async (input) => {
    const runtime = await createSkillsRuntime({
      repository: createRepository(),
      agentId: "agent-1",
      userId: "user-1",
    });

    await expect(execute(runtime, "skill_view", input)).rejects.toThrow(
      SKILL_NOT_AVAILABLE,
    );
  });

  it("uses the same generic error for inaccessible repository results", async () => {
    const repository = createRepository();
    repository.selectSkillById = vi.fn(async () => null);
    const runtime = await createSkillsRuntime({
      repository,
      agentId: "agent-1",
      userId: "user-1",
    });

    await expect(
      execute(runtime, "skill_view", { skillId: "review" }),
    ).rejects.toThrow(SKILL_NOT_AVAILABLE);
  });

  it("caps assigned skills at 20", async () => {
    const repository = createRepository();
    repository.selectSkillSummariesByAgentId = vi.fn(async () =>
      Array.from({ length: 25 }, (_, index) => ({
        id: `skill-${index}`,
        name: `Skill ${index}`,
      })),
    );
    const runtime = await createSkillsRuntime({
      repository,
      agentId: "agent-1",
      userId: "user-1",
    });

    expect(repository.selectSkillSummariesByAgentId).toHaveBeenCalledWith(
      "agent-1",
      "user-1",
      MAX_ASSIGNED_SKILLS,
    );
    expect(runtime.manifest).toHaveLength(MAX_ASSIGNED_SKILLS);
  });

  it("makes scoped learned skills available without an agent assignment", async () => {
    const repository = createRepository();
    const runtime = await createSkillsRuntime({
      repository,
      userId: "user-1",
      additionalSkills: [
        { id: "review", name: "Code Review", description: "Review safely" },
      ],
    });

    expect(repository.selectSkillsByAgentId).not.toHaveBeenCalled();
    expect(runtime.manifest).toEqual([
      { id: "review", name: "Code Review", description: "Review safely" },
    ]);
    await expect(
      execute(runtime, "skill_view", { skillId: "review" }),
    ).resolves.toMatchObject({ content: "Full instructions" });
  });

  it("binds reserved tools after colliding tools", async () => {
    const runtime = await createSkillsRuntime({
      repository: createRepository(),
      agentId: "agent-1",
      userId: "user-1",
    });
    const collision = { execute: vi.fn() } as any;
    const tools = bindSkillTools(
      { skills_list: collision, skill_view: collision },
      runtime.tools,
    );

    expect(tools.skills_list).toBe(runtime.tools.skills_list);
    expect(tools.skill_view).toBe(runtime.tools.skill_view);
  });
});
