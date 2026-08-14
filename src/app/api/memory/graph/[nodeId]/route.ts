import { getSession } from "auth/server";
import { memoryGraphRepository } from "lib/db/repository";
import { resolveMemoryScopeFromRequest } from "lib/ai/memory/scope-server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ nodeId: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const depth = Math.min(
    3,
    Math.max(1, Number(new URL(request.url).searchParams.get("depth") ?? 1)),
  );
  const scope = await resolveMemoryScopeFromRequest(session.user.id, request);
  return Response.json(
    await memoryGraphRepository.neighbors(
      session.user.id,
      (await params).nodeId,
      depth,
      scope,
    ),
  );
}
