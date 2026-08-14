import { getSession } from "auth/server";
import { memoryGraphRepository } from "lib/db/repository";

export async function GET() {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json(await memoryGraphRepository.activity(session.user.id));
}
