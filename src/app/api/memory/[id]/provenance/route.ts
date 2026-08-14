import { MemoryNodeTypeSchema } from "app-types/memory";
import { getSession } from "auth/server";
import { memoryGraphRepository } from "lib/db/repository";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = MemoryNodeTypeSchema.safeParse(
    new URL(request.url).searchParams.get("type") ?? "claim",
  );
  if (!parsed.success)
    return Response.json({ error: "Invalid node type" }, { status: 400 });
  return Response.json(
    await memoryGraphRepository.provenance(
      session.user.id,
      (await params).id,
      parsed.data,
    ),
  );
}
