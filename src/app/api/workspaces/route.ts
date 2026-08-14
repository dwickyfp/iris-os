import { getSession } from "auth/server";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { workspaceService } from "lib/workspace/server";
import {
  WorkspaceCreateSchema,
  WorkspaceStatusSchema,
} from "app-types/workspace";
import { z } from "zod";

function unavailable() {
  return Response.json({ error: "Not found" }, { status: 404 });
}

export async function GET(request: Request) {
  if (!isV2FeatureEnabled("workspaces")) return unavailable();
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });

  const rawStatus =
    new URL(request.url).searchParams.get("status") ?? undefined;
  const status = WorkspaceStatusSchema.optional().safeParse(rawStatus);
  if (!status.success)
    return Response.json({ error: status.error.issues }, { status: 400 });
  return Response.json(
    await workspaceService.list(session.user.id, status.data),
  );
}

export async function POST(request: Request) {
  if (!isV2FeatureEnabled("workspaces")) return unavailable();
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const input = WorkspaceCreateSchema.parse(await request.json());
    return Response.json(
      await workspaceService.create(session.user.id, input),
      {
        status: 201,
      },
    );
  } catch (error: any) {
    if (error?.code === "23505")
      return Response.json(
        { error: "A workspace with this slug already exists" },
        { status: 409 },
      );
    return Response.json(
      { error: error instanceof z.ZodError ? error.issues : "Invalid request" },
      { status: 400 },
    );
  }
}
