import { z } from "zod";
import { getSession } from "auth/server";
import { memoryGraphRepository } from "lib/db/repository";
import { resolveMemoryScopeFromRequest } from "lib/ai/memory/scope-server";

const ResolutionSchema = z.object({
  resolution: z.enum(["source", "target", "both"]),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { resolution } = ResolutionSchema.parse(await request.json());
    const scope = await resolveMemoryScopeFromRequest(session.user.id, request);
    await memoryGraphRepository.resolveConflict(
      session.user.id,
      (await params).id,
      resolution,
      scope,
    );
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof z.ZodError ? error.issues : "Conflict not found",
      },
      { status: 400 },
    );
  }
}
