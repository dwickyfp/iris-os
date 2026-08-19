import { remoteAgentService } from "lib/remote-agent/server";
import { remoteAgentError, remoteAgentUserId } from "../route-utils";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const userId = await remoteAgentUserId();
  if (userId instanceof Response) return userId;
  try {
    return Response.json(
      await remoteAgentService.get(userId, (await params).id),
    );
  } catch (error) {
    return remoteAgentError(error);
  }
}

export async function PATCH(request: Request, { params }: Context) {
  const userId = await remoteAgentUserId();
  if (userId instanceof Response) return userId;
  try {
    return Response.json(
      await remoteAgentService.update(
        userId,
        (await params).id,
        await request.json(),
      ),
    );
  } catch (error) {
    return remoteAgentError(error);
  }
}

export async function DELETE(_request: Request, { params }: Context) {
  const userId = await remoteAgentUserId();
  if (userId instanceof Response) return userId;
  try {
    await remoteAgentService.delete(userId, (await params).id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return remoteAgentError(error);
  }
}
