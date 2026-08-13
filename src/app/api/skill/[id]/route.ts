import { getSession } from "auth/server";
import { canDeleteSkill, canEditSkill } from "lib/auth/permissions";
import { z } from "zod";
import { getSkillForMutation } from "../access";
import { skillsHttpRepository } from "../repository";
import {
  SkillRouteUpdateSchema,
  invalidResponse,
  isRepositoryConflict,
  readJson,
} from "../validation";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const session = await getSession();
  if (!session?.user.id) return unauthorized();

  const { id } = await params;
  const skill = await skillsHttpRepository.selectSkillById(id, session.user.id);
  if (!skill) {
    return Response.json({ error: "Skill not found" }, { status: 404 });
  }
  return Response.json(skill);
}

export async function PUT(request: Request, { params }: Context) {
  const session = await getSession();
  if (!session?.user.id) return unauthorized();
  if (!(await canEditSkill())) return forbidden();

  try {
    const { id } = await params;
    const access = await getSkillForMutation(id, session.user.id);
    if (access.response) return access.response;

    const input = SkillRouteUpdateSchema.parse(await readJson(request));
    const skill = await skillsHttpRepository.updateSkill(
      id,
      session.user.id,
      input,
    );
    return Response.json(skill);
  } catch (error) {
    if (error instanceof z.ZodError) return invalidResponse(error);
    if (isRepositoryConflict(error)) {
      return Response.json(
        { error: "Skill update conflicts" },
        { status: 409 },
      );
    }
    console.error("Failed to update skill:", error);
    return internalError();
  }
}

export async function DELETE(_request: Request, { params }: Context) {
  const session = await getSession();
  if (!session?.user.id) return unauthorized();
  if (!(await canDeleteSkill())) return forbidden();

  try {
    const { id } = await params;
    const access = await getSkillForMutation(id, session.user.id);
    if (access.response) return access.response;
    await skillsHttpRepository.archiveSkill(id, session.user.id);
    return Response.json({ success: true });
  } catch (error) {
    if (isRepositoryConflict(error)) {
      return Response.json(
        { error: "Skill cannot be archived" },
        { status: 409 },
      );
    }
    console.error("Failed to archive skill:", error);
    return internalError();
  }
}

function unauthorized() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function forbidden() {
  return Response.json({ error: "Forbidden" }, { status: 403 });
}

function internalError() {
  return Response.json({ error: "Internal Server Error" }, { status: 500 });
}
