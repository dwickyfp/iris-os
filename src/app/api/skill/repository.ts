import type { Skill, SkillSummary } from "app-types/skill";
import { skillRepository } from "lib/db/repository";

type SkillListOptions = {
  filters: ("all" | "mine" | "shared" | "bookmarked")[];
  limit: number;
  archived: boolean;
};

export type SkillsHttpRepository = typeof skillRepository & {
  selectSkills(
    userId: string,
    filters?: SkillListOptions["filters"],
    limit?: number,
    archived?: boolean,
  ): Promise<SkillSummary[]>;
  archiveSkill(id: string, userId: string): Promise<Skill | void>;
  restoreSkill(id: string, userId: string): Promise<Skill | void>;
};

export const skillsHttpRepository = skillRepository as SkillsHttpRepository;
