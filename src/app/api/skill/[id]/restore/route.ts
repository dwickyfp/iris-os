import { getSession } from "auth/server";
import { canEditSkill } from "lib/auth/permissions";
import { getSkillForMutation } from "../../access";
import { skillsHttpRepository } from "../../repository";
import { isRepositoryConflict } from "../../validation";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await canEditSkill())) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { id } = await params;
    const access = await getSkillForMutation(id, session.user.id);
    if (access.response) return access.response;
    const restored = await skillsHttpRepository.restoreSkill(
      id,
      session.user.id,
    );
    return Response.json(restored ?? { success: true });
  } catch (error) {
    if (isRepositoryConflict(error)) {
      return Response.json({ error: "Skill is not archived" }, { status: 409 });
    }
    console.error("Failed to restore skill:", error);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
