import { getSession } from "auth/server";
import { memoryRepository } from "lib/db/repository";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return Response.json(
      await memoryRepository.restore((await params).id, session.user.id),
    );
  } catch {
    return Response.json({ error: "Memory not found" }, { status: 404 });
  }
}
