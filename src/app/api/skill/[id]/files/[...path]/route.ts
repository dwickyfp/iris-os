import { getSession } from "auth/server";
import { canEditSkill } from "lib/auth/permissions";
import { z } from "zod";
import { getSkillForMutation } from "../../../access";
import { skillsHttpRepository } from "../../../repository";
import {
  SkillFileUpsertSchema,
  SkillRouteUpdateSchema,
  invalidResponse,
  isRepositoryConflict,
  parseSkillFilePath,
  readJson,
} from "../../../validation";

type Context = { params: Promise<{ id: string; path: string[] }> };

export async function PUT(request: Request, { params }: Context) {
  const session = await getSession();
  if (!session?.user.id) return unauthorized();
  if (!(await canEditSkill())) return forbidden();

  try {
    const { id, path: segments } = await params;
    const access = await getSkillForMutation(id, session.user.id);
    if (access.response) return access.response;
    const path = parseSkillFilePath(segments);
    const input = SkillFileUpsertSchema.parse(await readJson(request));
    const file = { path, ...input };
    const files =
      access.skill?.files.filter((item) => item.path !== path) ?? [];
    const update = SkillRouteUpdateSchema.parse({ files: [...files, file] });
    await skillsHttpRepository.updateSkill(id, session.user.id, {
      files: update.files,
    });
    return Response.json(file);
  } catch (error) {
    if (error instanceof z.ZodError) return invalidResponse(error);
    if (isRepositoryConflict(error)) {
      return Response.json(
        { error: "Skill file limit exceeded" },
        { status: 409 },
      );
    }
    console.error("Failed to upsert skill file:", error);
    return internalError();
  }
}

export async function DELETE(_request: Request, { params }: Context) {
  const session = await getSession();
  if (!session?.user.id) return unauthorized();
  if (!(await canEditSkill())) return forbidden();

  try {
    const { id, path: segments } = await params;
    const access = await getSkillForMutation(id, session.user.id);
    if (access.response) return access.response;
    const path = parseSkillFilePath(segments);
    const files = access.skill?.files ?? [];
    if (!files.some((file) => file.path === path)) {
      return Response.json({ error: "Skill file not found" }, { status: 404 });
    }
    await skillsHttpRepository.updateSkill(id, session.user.id, {
      files: files.filter((file) => file.path !== path),
    });
    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) return invalidResponse(error);
    console.error("Failed to delete skill file:", error);
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
