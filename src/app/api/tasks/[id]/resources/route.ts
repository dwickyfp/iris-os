import { getSession } from "auth/server";
import { ResourceRefCreateSchema } from "app-types/task";
import { taskRepository } from "lib/db/repository";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const input = ResourceRefCreateSchema.parse(await request.json());
  const resource = await taskRepository.addResource(
    (await params).id,
    session.user.id,
    input,
  );
  return resource
    ? Response.json(resource, { status: 201 })
    : Response.json({ error: "Task not found" }, { status: 404 });
}
