import { getSession } from "auth/server";
import { AutomationCreateSchema } from "app-types/automation";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { z } from "zod";
import {
  createManagedAutomation,
  listManagedAutomations,
} from "lib/automation/management";

export async function GET() {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("automation"))
    return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(await listManagedAutomations(session.user.id));
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("automation"))
    return Response.json({ error: "Not found" }, { status: 404 });
  try {
    const input = AutomationCreateSchema.parse(await request.json());
    const automation = await createManagedAutomation(session.user.id, input);
    return Response.json(automation, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof z.ZodError ? error.issues : "Invalid automation",
      },
      { status: 400 },
    );
  }
}
