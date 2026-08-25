import { getSession } from "auth/server";
import { consumeRunInbox, dismissRunInbox } from "lib/ai/runs/run-inbox.server";
import { z } from "zod";

const ActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("consume"),
    targetRunId: z.string().uuid(),
  }),
  z.object({ action: z.literal("dismiss") }),
]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = ActionSchema.safeParse(await request.json());
  if (!parsed.success)
    return Response.json(
      { error: "Invalid inbox action", issues: parsed.error.issues },
      { status: 400 },
    );
  const item =
    parsed.data.action === "consume"
      ? await consumeRunInbox({
          id,
          userId: session.user.id,
          targetRunId: parsed.data.targetRunId,
        })
      : await dismissRunInbox(id, session.user.id);
  return item
    ? Response.json(item)
    : Response.json({ error: "Inbox item not found" }, { status: 404 });
}
