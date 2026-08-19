import { remoteAgentService } from "lib/remote-agent/server";
import { remoteAgentError, remoteAgentUserId } from "../../route-utils";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await remoteAgentUserId();
  if (userId instanceof Response) return userId;
  try {
    return Response.json(
      await remoteAgentService.sendTask(
        userId,
        (await params).id,
        await request.json(),
      ),
      { status: 201 },
    );
  } catch (error) {
    return remoteAgentError(error);
  }
}
