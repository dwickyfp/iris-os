import { getSession } from "auth/server";
import { canCreateSkill } from "lib/auth/permissions";
import { z } from "zod";
import { skillsHttpRepository } from "./repository";
import {
  SkillCollectionQuerySchema,
  SkillRouteCreateSchema,
  invalidResponse,
  isRepositoryConflict,
  readJson,
} from "./validation";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.user.id) return unauthorized();

  try {
    const query = SkillCollectionQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const filters = (query.filters?.split(",").map((value) => value.trim()) ?? [
      query.type,
    ]) as ("all" | "mine" | "shared" | "bookmarked")[];
    const parsedFilters = z
      .array(z.enum(["all", "mine", "shared", "bookmarked"]))
      .min(1)
      .parse(filters);

    const skills = query.archived
      ? (await skillsHttpRepository.selectSkillsByUserId(session.user.id))
          .filter((skill) => skill.archivedAt)
          .slice(0, query.limit)
      : await skillsHttpRepository.selectSkills(
          session.user.id,
          parsedFilters,
          query.limit,
        );
    return Response.json(skills);
  } catch (error) {
    if (error instanceof z.ZodError) return invalidResponse(error);
    console.error("Failed to list skills:", error);
    return internalError();
  }
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.id) return unauthorized();
  if (!(await canCreateSkill())) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const input = SkillRouteCreateSchema.parse(await readJson(request));
    const skill = await skillsHttpRepository.insertSkill({
      ...input,
      userId: session.user.id,
    });
    return Response.json(skill, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return invalidResponse(error);
    if (isRepositoryConflict(error)) {
      return Response.json({ error: "Skill already exists" }, { status: 409 });
    }
    console.error("Failed to create skill:", error);
    return internalError();
  }
}

function unauthorized() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function internalError() {
  return Response.json({ error: "Internal Server Error" }, { status: 500 });
}
