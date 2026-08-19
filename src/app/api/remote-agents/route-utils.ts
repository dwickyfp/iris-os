import { getSession } from "auth/server";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { z } from "zod";

export async function remoteAgentUserId() {
  if (!isV2FeatureEnabled("remoteAgents")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const session = await getSession();
  if (!session?.user.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return session.user.id;
}

export function remoteAgentError(error: unknown) {
  if (error instanceof z.ZodError) {
    return Response.json({ error: error.issues }, { status: 400 });
  }
  if (
    error instanceof Error &&
    (error.message === "Remote agent not found" ||
      error.message === "Remote agent is disabled")
  ) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "23505"
  ) {
    return Response.json(
      { error: "This remote agent endpoint is already registered" },
      { status: 409 },
    );
  }
  return Response.json(
    { error: error instanceof Error ? error.message : "Invalid request" },
    { status: 400 },
  );
}
