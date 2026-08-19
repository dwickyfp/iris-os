import { type Tool, jsonSchema, tool } from "ai";
import { createSkillManifest } from "./manifest";
import { assertSafeSkillPath } from "./path";
import {
  type AssignedSkill,
  type AssignedSkillsRepository,
  MAX_ASSIGNED_SKILLS,
  SKILLS_LIST_TOOL_NAME,
  SKILL_NOT_AVAILABLE,
  SKILL_VIEW_TOOL_NAME,
  type SkillManifestEntry,
} from "./types";

export type SkillsRuntime = {
  manifest: SkillManifestEntry[];
  tools: Record<string, Tool>;
  select(skillIds: readonly string[]): SkillsRuntime;
};

export function bindSkillTools(
  tools: Record<string, Tool>,
  skillTools: Record<string, Tool>,
): Record<string, Tool> {
  // Reserved runtime tools must not be replaceable by MCP or application tools.
  return { ...tools, ...skillTools };
}

export async function createSkillsRuntime({
  repository,
  agentId,
  userId,
  additionalSkills = [],
}: {
  repository: AssignedSkillsRepository;
  agentId?: string;
  userId: string;
  additionalSkills?: SkillManifestEntry[];
}): Promise<SkillsRuntime> {
  const assigned = agentId
    ? repository.selectSkillSummariesByAgentId
      ? await repository.selectSkillSummariesByAgentId(
          agentId,
          userId,
          MAX_ASSIGNED_SKILLS,
        )
      : await repository.selectSkillsByAgentId(agentId, userId)
    : [];
  const manifest = createSkillManifest(
    [...assigned, ...additionalSkills].filter(
      (skill, index, skills) =>
        skills.findIndex((candidate) => candidate.id === skill.id) === index,
    ),
  );
  const assignedById = new Map(manifest.map((skill) => [skill.id, skill]));
  const loads = new Map<string, Promise<unknown>>();
  const loadedSkills = new Set<string>();
  const completedViews = new Set<string>();

  function deduplicate<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = loads.get(key);
    if (existing) return existing as Promise<T>;
    const pending = load().catch((error) => {
      loads.delete(key);
      throw error;
    });
    loads.set(key, pending);
    return pending;
  }

  async function loadSkill(skillId: string): Promise<AssignedSkill> {
    if (!assignedById.has(skillId)) throw new Error(SKILL_NOT_AVAILABLE);
    const skill = await deduplicate(`skill:${skillId}`, () =>
      repository.selectSkillById(skillId, userId),
    );
    if (!skill) throw new Error(SKILL_NOT_AVAILABLE);
    return skill;
  }

  async function loadContent(skillId: string) {
    if (!assignedById.has(skillId)) throw new Error(SKILL_NOT_AVAILABLE);
    if (repository.selectSkillContentById) {
      const content = await deduplicate(`content:${skillId}`, () =>
        repository.selectSkillContentById!(skillId, userId),
      );
      if (!content) throw new Error(SKILL_NOT_AVAILABLE);
      return content;
    }
    const skill = await loadSkill(skillId);
    return {
      body: skill.body,
      resources: skill.files.map((file) => file.path),
    };
  }

  async function viewSkill(skillId: string, filePath?: string) {
    const key = `view:${skillId}:${filePath ?? "body"}`;
    if (completedViews.has(key) || loads.has(key)) {
      if (loads.has(key)) {
        try {
          await loads.get(key);
        } catch {
          throw new Error(SKILL_NOT_AVAILABLE);
        }
      }
      return {
        skillId,
        ...(filePath ? { filePath } : {}),
        alreadyLoaded: true,
      };
    }

    const pending = (async () => {
      const skillContent = await loadContent(skillId);
      let content = skillContent.body;
      if (filePath) {
        const safePath = assertSafeSkillPath(filePath);
        if (!skillContent.resources.includes(safePath)) {
          throw new Error(SKILL_NOT_AVAILABLE);
        }
        const file = repository.selectSkillFileByPath
          ? await deduplicate(`file:${skillId}:${safePath}`, () =>
              repository.selectSkillFileByPath!(skillId, safePath, userId),
            )
          : (await loadSkill(skillId)).files.find(
              (candidate) => candidate.path === safePath,
            );
        if (!file) throw new Error(SKILL_NOT_AVAILABLE);
        content = file.content;
      }
      return {
        skill: assignedById.get(skillId)!,
        ...(filePath ? { filePath } : {}),
        content,
        resources: skillContent.resources,
        alreadyLoaded: false,
      };
    })();
    loads.set(key, pending);

    try {
      const response = await pending;
      completedViews.add(key);
      loadedSkills.add(skillId);
      return response;
    } catch {
      loads.delete(key);
      throw new Error(SKILL_NOT_AVAILABLE);
    }
  }

  function select(skillIds: readonly string[]): SkillsRuntime {
    const selected = new Set(skillIds);
    return buildRuntime(manifest.filter((skill) => selected.has(skill.id)));
  }

  function buildRuntime(visibleManifest: SkillManifestEntry[]): SkillsRuntime {
    const visibleById = new Set(visibleManifest.map((skill) => skill.id));
    return {
      manifest: visibleManifest,
      select,
      tools: {
        [SKILLS_LIST_TOOL_NAME]: tool({
          description:
            "List or search metadata for skills assigned to this agent, including whether each skill has been loaded.",
          inputSchema: jsonSchema<{ query?: string }>({
            type: "object",
            properties: { query: { type: "string" } },
            additionalProperties: false,
          }),
          execute: async ({ query }: { query?: string }) => {
            const normalizedQuery = query?.trim().toLocaleLowerCase();
            const matches = normalizedQuery
              ? visibleManifest.filter((skill) =>
                  `${skill.name}\n${skill.description ?? ""}`
                    .toLocaleLowerCase()
                    .includes(normalizedQuery),
                )
              : visibleManifest;
            return {
              skills: matches.slice(0, MAX_ASSIGNED_SKILLS).map((skill) => ({
                ...skill,
                loaded: loadedSkills.has(skill.id),
              })),
            };
          },
        }),
        [SKILL_VIEW_TOOL_NAME]: tool({
          description:
            "Load an assigned skill's instructions, or one of its referenced files.",
          inputSchema: jsonSchema<{
            skillId: string;
            filePath?: string;
            path?: string;
          }>({
            type: "object",
            properties: {
              skillId: { type: "string", minLength: 1 },
              filePath: { type: "string", minLength: 1 },
              path: { type: "string", minLength: 1 },
            },
            required: ["skillId"],
            additionalProperties: false,
          }),
          execute: async ({
            skillId,
            filePath,
            path,
          }: { skillId: string; filePath?: string; path?: string }) => {
            if (filePath && path && filePath !== path) {
              throw new Error(SKILL_NOT_AVAILABLE);
            }
            if (!visibleById.has(skillId)) throw new Error(SKILL_NOT_AVAILABLE);
            return viewSkill(skillId, filePath ?? path);
          },
        }),
      },
    };
  }

  return buildRuntime(manifest);
}
