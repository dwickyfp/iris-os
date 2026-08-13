import { getSession } from "auth/server";
import { skillsHttpRepository } from "../../repository";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const skill = await skillsHttpRepository.selectSkillById(id, session.user.id);
  if (!skill) {
    return Response.json({ error: "Skill not found" }, { status: 404 });
  }
  return Response.json(skill.files);
}
