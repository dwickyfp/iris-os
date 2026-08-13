import { getSession } from "auth/server";
import { mcpRepository } from "lib/db/repository";
import { mcpClientsManager } from "lib/ai/mcp/mcp-manager";
import { z } from "zod";

const requestSchema = z.object({
  serverName: z.string().min(1),
  uri: z.string().min(1),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.id) return new Response("Unauthorized", { status: 401 });

  const { serverName, uri } = requestSchema.parse(await request.json());
  const server = await mcpRepository.selectByServerName(serverName);
  if (
    !server ||
    (server.userId !== session.user.id && server.visibility !== "public")
  ) {
    return new Response("Forbidden", { status: 403 });
  }

  const resource = await mcpClientsManager.readResource(server.id, uri);
  return Response.json(resource);
}
