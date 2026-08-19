import { remoteAgentService } from "lib/remote-agent/server";
import { remoteAgentError, remoteAgentUserId } from "../../route-utils";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await remoteAgentUserId();
  if (userId instanceof Response) return userId;
  try {
    return Response.json(
      await remoteAgentService.discover(userId, (await params).id),
    );
  } catch (error) {
    return remoteAgentError(error);
  }
}
