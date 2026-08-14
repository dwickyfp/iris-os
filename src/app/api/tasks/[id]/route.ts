import { getSession } from "auth/server";
import { TaskUpdateSchema } from "app-types/task";
import { taskRepository, workspaceRepository } from "lib/db/repository";
import { z } from "zod";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
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
    if (
      input.parentTaskId &&
      !(await taskRepository.select(input.parentTaskId, session.user.id))
    )
      return Response.json({ error: "Parent task not found" }, { status: 404 });
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
