import { AgentRunResumeSchema } from "app-types/remote-agent";
import { getSession } from "auth/server";
import { runManager } from "lib/ai/runs/server";
import { agentRunRepository } from "lib/db/repository";
import { enqueueDelegatedRun } from "lib/delegation/queue";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { encryptRemoteAgentSecret } from "lib/security/secrets";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const runId = (await params).id;
  const parsed = AgentRunResumeSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return Response.json({ error: "Invalid resume body" }, { status: 400 });
  const current = await agentRunRepository.selectById(runId, session.user.id);
  if (!current)
    return Response.json({ error: "Run not found" }, { status: 404 });
  const resumed = await runManager.resume({
    runId,
    userId: session.user.id,
    continuation:
      parsed.data.kind === "input"
        ? { kind: "input", payload: { message: parsed.data.message } }
        : {
            kind: "credential",
            encryptedCredential: encryptRemoteAgentSecret(
              JSON.stringify(parsed.data.credential),
            ),
          },
  });
  if (!resumed)
    return Response.json({ error: "Run is not waiting" }, { status: 409 });
  if (isV2FeatureEnabled("delegation") && (await enqueueDelegatedRun(runId)))
    await runManager.markDispatched(runId);
  return Response.json(resumed);
}
