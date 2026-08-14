import { getSession } from "auth/server";
import { AutomationCreateSchema } from "app-types/automation";
import { desc, eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { AutomationTable } from "lib/db/pg/schema.pg";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { generateUUID } from "lib/utils";
import { z } from "zod";
import {
  agentRepository,
  skillRepository,
  workflowRepository,
  workspaceRepository,
} from "lib/db/repository";
import { enqueueAutomationRefresh } from "lib/automation/queue";

export async function GET() {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("automation"))
    return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(
    await pgDb
      .select()
      .from(AutomationTable)
      .where(eq(AutomationTable.userId, session.user.id))
      .orderBy(desc(AutomationTable.updatedAt)),
  );
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("automation"))
    return Response.json({ error: "Not found" }, { status: 404 });
  try {
    const input = AutomationCreateSchema.parse(await request.json());
    if (input.triggerType === "schedule" && !input.cron)
      return Response.json(
        { error: "Scheduled automation requires cron" },
        { status: 400 },
      );
    if (
      input.workspaceId &&
      !(await workspaceRepository.selectById(
        input.workspaceId,
        session.user.id,
      ))
    )
      return Response.json({ error: "Workspace not found" }, { status: 404 });
    const targetExists =
      input.targetType === "workflow"
        ? await workflowRepository.checkAccess(input.targetId, session.user.id)
        : input.targetType === "skill"
          ? Boolean(
              await skillRepository.selectSkillById(
                input.targetId,
                session.user.id,
              ),
            )
          : Boolean(
              await agentRepository.selectAgentById(
                input.targetId,
                session.user.id,
              ),
            );
    if (!targetExists)
      return Response.json(
        { error: "Automation target not found" },
        { status: 404 },
      );
    const [automation] = await pgDb
      .insert(AutomationTable)
      .values({ ...input, id: generateUUID(), userId: session.user.id })
      .returning();
    if (automation.triggerType === "schedule")
      void enqueueAutomationRefresh(automation.id);
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
