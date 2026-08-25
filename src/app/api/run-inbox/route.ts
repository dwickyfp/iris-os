import { getSession } from "auth/server";
import {
  enqueueRunInbox,
  listRunInbox,
  reviseRunGoal,
} from "lib/ai/runs/run-inbox.server";
import { goalRequirementResolver } from "lib/ai/runtime/goal-requirement-resolver";
import { agentRunRepository } from "lib/db/repository";
import { z } from "zod";

const CreateInboxSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("steer"),
    rootRunId: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    objective: z.string().trim().min(1).max(20_000),
    sourceMessageId: z.string().uuid().optional(),
    idempotencyKey: z.string().trim().min(1).max(240),
  }),
  z.object({
    mode: z.literal("followup"),
    rootRunId: z.string().uuid(),
    targetRunId: z.string().uuid(),
    source: z.literal("user"),
    content: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string().trim().min(1).max(240),
  }),
]);

export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const items = await listRunInbox(session.user.id);
  if (new URL(request.url).searchParams.get("summary") === "1")
    return Response.json({ open: items.length });
  return Response.json(items);
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = CreateInboxSchema.safeParse(await request.json());
  if (!parsed.success)
    return Response.json(
      { error: "Invalid inbox item", issues: parsed.error.issues },
      { status: 400 },
    );
  if (JSON.stringify(parsed.data).length > 32_000)
    return Response.json(
      { error: "Inbox payload is too large" },
      { status: 413 },
    );
  const root = await agentRunRepository.selectById(
    parsed.data.rootRunId,
    session.user.id,
  );
  if (!root || root.rootRunId !== root.id)
    return Response.json({ error: "Run not found" }, { status: 404 });
  try {
    if (parsed.data.mode === "steer") {
      return Response.json(
        await reviseRunGoal({
          rootRunId: parsed.data.rootRunId,
          userId: session.user.id,
          expectedRevision: parsed.data.expectedRevision,
          requirement: goalRequirementResolver.resolve({
            goal: parsed.data.objective,
          }),
          sourceMessageId: parsed.data.sourceMessageId,
          content: { objective: parsed.data.objective },
          idempotencyKey: parsed.data.idempotencyKey,
        }),
      );
    }
    return Response.json(
      await enqueueRunInbox({
        ...parsed.data,
        userId: session.user.id,
        goalRevision: root.goalRevision,
      }),
    );
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "RUN_GOAL_REVISION_CONFLICT")
        return Response.json({ error: error.message }, { status: 409 });
      if (error.message === "RUN_GOAL_NOT_AT_SAFE_BOUNDARY")
        return Response.json({ error: error.message }, { status: 409 });
      if (error.message === "RUN_GOAL_NOT_FOUND")
        return Response.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
