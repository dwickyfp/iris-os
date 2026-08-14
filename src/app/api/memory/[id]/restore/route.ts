import { getSession } from "auth/server";
import { memoryRepository } from "lib/db/repository";
import { resolveMemoryScopeFromRequest } from "lib/ai/memory/scope-server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const scope = await resolveMemoryScopeFromRequest(session.user.id, request);
    return Response.json(
      await memoryRepository.restore((await params).id, session.user.id, scope),
    );
  } catch {
    return Response.json({ error: "Memory not found" }, { status: 404 });
  }
}
