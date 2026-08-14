import { WorkspaceUpdateSchema } from "app-types/workspace";
import { getSession } from "auth/server";
import { workspaceRepository } from "lib/db/repository";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { workspaceService } from "lib/workspace/server";
import { z } from "zod";

function unavailable() {
  return Response.json({ error: "Not found" }, { status: 404 });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isV2FeatureEnabled("workspaces")) return unavailable();
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const workspace = await workspaceRepository.selectById(id, session.user.id);
  return workspace
    ? Response.json(workspace)
    : Response.json({ error: "Workspace not found" }, { status: 404 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isV2FeatureEnabled("workspaces")) return unavailable();
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { id } = await params;
    const input = WorkspaceUpdateSchema.parse(await request.json());
    return Response.json(
      await workspaceService.update(session.user.id, id, input),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Workspace not found")
      return Response.json({ error: error.message }, { status: 404 });
    return Response.json(
      { error: error instanceof z.ZodError ? error.issues : "Invalid request" },
      { status: 400 },
    );
  }
}
