import { getSession } from "auth/server";
import { logger } from "better-auth";
import { canCreateMCP } from "lib/auth/permissions";
import { NextResponse } from "next/server";
import { mcpServerUpsertSchema, saveMcpClientAction } from "./actions";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check if user has permission to create MCP connections
  const hasPermission = await canCreateMCP();
  if (!hasPermission) {
    return NextResponse.json(
      { error: "You don't have permission to create MCP connections" },
      { status: 403 },
    );
  }

  let body: import("zod").infer<typeof mcpServerUpsertSchema>;
  try {
    body = mcpServerUpsertSchema.parse(await request.json());
  } catch (error: any) {
    return NextResponse.json(
      { message: "Invalid MCP server payload", details: error.issues },
      { status: 400 },
    );
  }

  try {
    const result = await saveMcpClientAction(body);

    return NextResponse.json({ success: true, id: result.client.getInfo().id });
  } catch (error: any) {
    logger.error("Failed to save MCP client", { error });
    return NextResponse.json(
      { message: error.message || "Failed to save MCP client" },
      { status: 500 },
    );
  }
}
