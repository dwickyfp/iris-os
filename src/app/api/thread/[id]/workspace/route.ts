import { getSession } from "auth/server";
import { chatRepository } from "lib/db/repository";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { workspaceService } from "lib/workspace/server";
import { z } from "zod";

const MoveThreadSchema = z.object({
  workspaceId: z.string().uuid().nullable(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isV2FeatureEnabled("workspaces"))
    return Response.json({ error: "Not found" }, { status: 404 });
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!(await chatRepository.checkAccess(id, session.user.id)))
    return Response.json({ error: "Thread not found" }, { status: 404 });

  try {
    const { workspaceId } = MoveThreadSchema.parse(await request.json());
    if (workspaceId)
      await workspaceService.resolveRequestedWorkspace(
        session.user.id,
        workspaceId,
      );
    return Response.json(
      await chatRepository.updateThread(id, { workspaceId }),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid workspace request";
    return Response.json({ error: message }, { status: 400 });
  }
}
