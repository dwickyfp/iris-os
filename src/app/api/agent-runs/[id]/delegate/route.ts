import { getSession } from "auth/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { intersectDelegationPermissions } from "lib/ai/agent/delegation-policy";
import { pgDb } from "lib/db/pg/db.pg";
import {
  AgentRunTable,
  AgentTable,
  DelegationRunTable,
} from "lib/db/pg/schema.pg";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { generateUUID } from "lib/utils";
import { skillRepository } from "lib/db/repository";

const DelegateSchema = z.object({
  childAgentId: z.string().uuid(),
  objective: z.string().trim().min(1).max(8_000),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
  context: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("delegation"))
    return Response.json({ error: "Not found" }, { status: 404 });
  const input = DelegateSchema.parse(await request.json());
  const [parent] = await pgDb
    .select()
    .from(AgentRunTable)
    .where(
      and(
        eq(AgentRunTable.id, (await params).id),
        eq(AgentRunTable.userId, session.user.id),
        eq(AgentRunTable.status, "running"),
      ),
    );
  const [childAgent] = await pgDb
    .select({ id: AgentTable.id })
    .from(AgentTable)
    .where(
      and(
        eq(AgentTable.id, input.childAgentId),
        eq(AgentTable.userId, session.user.id),
      ),
    );
  if (!parent || !childAgent)
    return Response.json(
      { error: "Run or child agent not found" },
      { status: 404 },
    );
  const childSkills = await skillRepository.selectSkillsByAgentId(
    childAgent.id,
    session.user.id,
  );
  const childTools = childSkills.flatMap((skill) => skill.allowedTools ?? []);
  const approvedTools = Array.isArray(parent.context.approvedDelegationTools)
    ? parent.context.approvedDelegationTools.filter(
        (tool): tool is string => typeof tool === "string",
      )
    : [];
  const allowedTools = intersectDelegationPermissions({
    parentTools: parent.allowedTools,
    childTools,
    approvedTools,
  });
  const childRunId = generateUUID();
  const delegationId = generateUUID();
  await pgDb.transaction(async (tx) => {
    await tx.insert(AgentRunTable).values({
      id: childRunId,
      userId: session.user.id,
      agentId: childAgent.id,
      parentRunId: parent.id,
      workspaceId: parent.workspaceId,
      taskId: parent.taskId,
      status: "queued",
      context: { ...input.context, objective: input.objective },
      allowedTools,
      timeoutMs: input.timeoutMs,
    });
    await tx.insert(DelegationRunTable).values({
      id: delegationId,
      parentRunId: parent.id,
      childRunId,
      userId: session.user.id,
      objective: input.objective,
    });
  });
  return Response.json(
    { id: delegationId, childRunId, status: "queued", allowedTools },
    { status: 202 },
  );
}
