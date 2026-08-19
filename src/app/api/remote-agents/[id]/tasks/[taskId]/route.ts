import { remoteAgentService } from "lib/remote-agent/server";
import { remoteAgentError, remoteAgentUserId } from "../../../route-utils";

type Context = { params: Promise<{ id: string; taskId: string }> };

export async function GET(_request: Request, { params }: Context) {
  const userId = await remoteAgentUserId();
  if (userId instanceof Response) return userId;
  try {
    const { id, taskId } = await params;
    return Response.json(await remoteAgentService.getTask(userId, id, taskId));
  } catch (error) {
    return remoteAgentError(error);
  }
}

export async function DELETE(_request: Request, { params }: Context) {
  const userId = await remoteAgentUserId();
  if (userId instanceof Response) return userId;
  try {
    const { id, taskId } = await params;
    return Response.json(
      await remoteAgentService.cancelTask(userId, id, taskId),
    );
  } catch (error) {
    return remoteAgentError(error);
  }
}
