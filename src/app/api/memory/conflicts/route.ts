import { getSession } from "auth/server";
import { memoryGraphRepository } from "lib/db/repository";
import { resolveMemoryScopeFromRequest } from "lib/ai/memory/scope-server";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const scope = await resolveMemoryScopeFromRequest(session.user.id, request);
  return Response.json(
    await memoryGraphRepository.conflicts(session.user.id, scope),
  );
}
