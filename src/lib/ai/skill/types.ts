export const SKILLS_LIST_TOOL_NAME = "skills_list";
export const SKILL_VIEW_TOOL_NAME = "skill_view";
export const SKILL_NOT_AVAILABLE = "SKILL_NOT_AVAILABLE";
export const MAX_ASSIGNED_SKILLS = 20;

export type SkillManifestEntry = {
  id: string;
  name: string;
  description?: string;
};

export type AssignedSkill = Omit<SkillManifestEntry, "files"> & {
  body: string;
  files: SkillFile[];
};

export type SkillFile = {
  path: string;
  content: string;
};

export type SkillContent = {
  body: string;
  resources: string[];
};

/**
 * Contract expected from lib/db/repository. Reads must enforce both the agent
 * assignment and user access; the runtime also checks against its manifest.
 */
export type AssignedSkillsRepository = {
  selectSkillSummariesByAgentId?(
    agentId: string,
    userId: string,
    limit: number,
  ): Promise<SkillManifestEntry[]>;
  selectSkillContentById?(
    skillId: string,
    userId: string,
  ): Promise<SkillContent | null>;
  selectSkillFileByPath?(
    skillId: string,
    filePath: string,
    userId: string,
  ): Promise<SkillFile | null>;
  selectSkillsByAgentId(
    agentId: string,
    userId: string,
  ): Promise<AssignedSkill[]>;
  selectSkillById(
    skillId: string,
    userId: string,
  ): Promise<AssignedSkill | null>;
};
