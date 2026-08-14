import { getSession } from "auth/server";
import { createDelegatedRun, DELEGATION_LIMITS } from "lib/delegation/service";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { z } from "zod";

const DelegateSchema = z.object({
  childAgentId: z.string().uuid(),
  objective: z.string().trim().min(1).max(8_000),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(DELEGATION_LIMITS.maxTimeoutMs)
    .default(DELEGATION_LIMITS.defaultTimeoutMs),
  tokenBudget: z.number().int().min(1_000).max(200_000).optional(),
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
  try {
    const input = DelegateSchema.parse(await request.json());
    return Response.json(
      await createDelegatedRun({
        ...input,
        userId: session.user.id,
        parentRunId: (await params).id,
      }),
      { status: 202 },
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "DELEGATION_FAILED";
    const status = code.includes("LIMIT") || code.includes("DEPTH") ? 409 : 404;
    return Response.json({ error: code }, { status });
  }
}
