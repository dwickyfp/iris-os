import { remoteAgentService } from "lib/remote-agent/server";
import { remoteAgentError, remoteAgentUserId } from "./route-utils";

export async function GET() {
  const userId = await remoteAgentUserId();
  if (userId instanceof Response) return userId;
  return Response.json(await remoteAgentService.list(userId));
}

export async function POST(request: Request) {
  const userId = await remoteAgentUserId();
  if (userId instanceof Response) return userId;
  try {
    return Response.json(
      await remoteAgentService.create(userId, await request.json()),
      { status: 201 },
    );
  } catch (error) {
    return remoteAgentError(error);
  }
}
