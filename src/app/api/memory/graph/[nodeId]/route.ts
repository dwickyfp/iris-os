import { getSession } from "auth/server";
import { memoryGraphRepository } from "lib/db/repository";

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
  return Response.json(
    await memoryGraphRepository.neighbors(
      session.user.id,
      (await params).nodeId,
      depth,
    ),
  );
}
