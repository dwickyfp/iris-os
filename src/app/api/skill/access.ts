import type { Skill } from "app-types/skill";
import { skillsHttpRepository } from "./repository";

export async function getSkillForMutation(
  id: string,
  userId: string,
): Promise<{ skill?: Skill; response?: Response }> {
  const skill = await skillsHttpRepository.selectSkillById(id, userId);
  if (!skill) {
    return {
      response: Response.json({ error: "Skill not found" }, { status: 404 }),
    };
  }
  if (skill.userId !== userId) {
    return {
      response: Response.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return { skill };
}
