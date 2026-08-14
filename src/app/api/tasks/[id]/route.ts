import { getSession } from "auth/server";
import { TaskUpdateSchema } from "app-types/task";
import { taskRepository, workspaceRepository } from "lib/db/repository";
import { z } from "zod";
import { isV2FeatureEnabled } from "lib/feature-flags";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("workspaces"))
    return Response.json({ error: "Not found" }, { status: 404 });
  const detail = await taskRepository.detail(
    (await params).id,
    session.user.id,
  );
  return detail
    ? Response.json(detail)
    : Response.json({ error: "Task not found" }, { status: 404 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("workspaces"))
    return Response.json({ error: "Not found" }, { status: 404 });
  try {
    const input = TaskUpdateSchema.parse(await request.json());
    if (
      input.workspaceId &&
      !(await workspaceRepository.selectById(
        input.workspaceId,
        session.user.id,
      ))
    )
      return Response.json({ error: "Workspace not found" }, { status: 404 });
    if (input.parentTaskId) {
      const [current, parent] = await Promise.all([
        taskRepository.select((await params).id, session.user.id),
        taskRepository.select(input.parentTaskId, session.user.id),
      ]);
      if (!parent)
        return Response.json(
          { error: "Parent task not found" },
          { status: 404 },
        );
      if (parent.id === current?.id)
        return Response.json(
          { error: "Task cannot be its own parent" },
          { status: 409 },
        );
      const workspaceId = input.workspaceId ?? current?.workspaceId ?? null;
      if ((parent.workspaceId ?? null) !== workspaceId)
        return Response.json(
          { error: "Parent task must use the same workspace" },
          { status: 409 },
        );
    }
    const task = await taskRepository.update(
      (await params).id,
      session.user.id,
      input,
    );
    return task
      ? Response.json(task)
      : Response.json({ error: "Task not found" }, { status: 404 });
  } catch (error) {
    return Response.json(
      { error: error instanceof z.ZodError ? error.issues : String(error) },
      { status: 400 },
    );
  }
}
