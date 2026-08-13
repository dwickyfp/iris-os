import { getSession } from "auth/server";
import { canEditAgent } from "lib/auth/permissions";
import { agentRepository } from "lib/db/repository";
import { z } from "zod";
import { skillsHttpRepository } from "../../../skill/repository";
import {
  AgentSkillsUpdateSchema,
  invalidResponse,
  isRepositoryConflict,
  readJson,
} from "../../../skill/validation";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const session = await getSession();
  if (!session?.user.id) return unauthorized();

  const { id } = await params;
  if (!(await agentRepository.checkAccess(id, session.user.id))) {
    return Response.json({ error: "Agent not found" }, { status: 404 });
  }
  const skills = await skillsHttpRepository.selectAgentSkillAssignments(
    id,
    session.user.id,
  );
  return Response.json(skills);
}

export async function PUT(request: Request, { params }: Context) {
  const session = await getSession();
  if (!session?.user.id) return unauthorized();
  if (!(await canEditAgent())) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { id } = await params;
    if (!(await agentRepository.checkAccess(id, session.user.id, true))) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    const { skillIds } = AgentSkillsUpdateSchema.parse(await readJson(request));
    await skillsHttpRepository.replaceAgentSkills(
      id,
      session.user.id,
      skillIds,
    );
    const skills = await skillsHttpRepository.selectAgentSkillAssignments(
      id,
      session.user.id,
    );
    return Response.json(skills);
  } catch (error) {
    if (error instanceof z.ZodError) return invalidResponse(error);
    if (isRepositoryConflict(error)) {
      return Response.json(
        { error: "One or more skills are unavailable" },
        { status: 409 },
      );
    }
    console.error("Failed to assign agent skills:", error);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

function unauthorized() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
