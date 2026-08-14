import { getSession } from "auth/server";
import { TaskCreateSchema } from "app-types/task";
import { taskRepository, workspaceRepository } from "lib/db/repository";
import { z } from "zod";
import { isV2FeatureEnabled } from "lib/feature-flags";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("workspaces"))
    return Response.json({ error: "Not found" }, { status: 404 });
  const workspaceId =
    new URL(request.url).searchParams.get("workspaceId") ?? undefined;
  return Response.json(await taskRepository.list(session.user.id, workspaceId));
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("workspaces"))
    return Response.json({ error: "Not found" }, { status: 404 });
  try {
    const input = TaskCreateSchema.parse(await request.json());
    if (
      input.workspaceId &&
      !(await workspaceRepository.selectById(
        input.workspaceId,
        session.user.id,
      ))
    ) {
      return Response.json({ error: "Workspace not found" }, { status: 404 });
    }
    if (input.parentTaskId) {
      const parent = await taskRepository.select(
        input.parentTaskId,
        session.user.id,
      );
      if (!parent)
        return Response.json(
          { error: "Parent task not found" },
          { status: 404 },
        );
      if ((parent.workspaceId ?? null) !== (input.workspaceId ?? null))
        return Response.json(
          { error: "Parent task must use the same workspace" },
          { status: 409 },
        );
    }
    return Response.json(await taskRepository.create(session.user.id, input), {
      status: 201,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof z.ZodError ? error.issues : "Invalid task" },
      { status: 400 },
    );
  }
}
