"use server";
import { mcpClientsManager } from "lib/ai/mcp/mcp-manager";
import { runtimeSystemSetting } from "lib/system-settings/runtime";
import { z } from "zod";

import {
  MCPRemoteConfigZodSchema,
  MCPStdioConfigZodSchema,
} from "app-types/mcp";
import {
  canCreateMCP,
  canManageMCPServer,
  canShareMCPServer,
  getCurrentUser,
} from "lib/auth/permissions";
import { mcpOAuthRepository, mcpRepository } from "lib/db/repository";

export const mcpServerUpsertSchema = z.object({
  id: z.string().uuid().optional(),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9\-]+$/, {
      message:
        "Name must contain only alphanumeric characters (A-Z, a-z, 0-9) and hyphens (-)",
    }),
  config: z.union([MCPRemoteConfigZodSchema, MCPStdioConfigZodSchema]),
  visibility: z.enum(["public", "private"]).optional(),
});

export async function selectMcpClientsAction() {
  // Get current user to filter MCP servers
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return [];
  }

  // Get all MCP servers the user can access (their own + shared)
  const accessibleServers = await mcpRepository.selectAllForUser(
    currentUser.id,
  );
  const accessibleIds = new Set(accessibleServers.map((s) => s.id));

  // Get all active clients and filter to only accessible ones
  const list = await mcpClientsManager.getClients();
  return list
    .filter(({ id }) => accessibleIds.has(id))
    .map(({ client, id }) => {
      const server = accessibleServers.find((s) => s.id === id);
      return {
        ...client.getInfo(),
        id,
        userId: server?.userId,
        visibility: server?.visibility,
        isOwner: server?.userId === currentUser.id,
        canManage: server
          ? server.userId === currentUser.id || currentUser.role === "admin"
          : false,
      };
    });
}

export async function selectMcpClientAction(id: string) {
  const client = await mcpClientsManager.getClient(id);
  if (!client) {
    throw new Error("Client not found");
  }
  return {
    ...client.client.getInfo(),
    id,
  };
}

export async function saveMcpClientAction(
  server: z.infer<typeof mcpServerUpsertSchema>,
) {
  if (runtimeSystemSetting("mcp.allowUserServers") !== true) {
    throw new Error("Not allowed to add MCP servers");
  }

  // Get current user
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    throw new Error("You must be logged in to create MCP connections");
  }

  // Check if user has permission to create/edit MCP connections
  const hasPermission = await canCreateMCP();
  if (!hasPermission) {
    throw new Error("You don't have permission to create MCP connections");
  }
  // Validate name to ensure it only contains alphanumeric characters and hyphens
  const nameResult = mcpServerUpsertSchema.shape.name.safeParse(server.name);
  if (!nameResult.success) {
    throw new Error(
      "Name must contain only alphanumeric characters (A-Z, a-z, 0-9) and hyphens (-)",
    );
  }

  // An update by id must target a server the caller is allowed to manage;
  // otherwise the upsert would let any user overwrite a shared server's
  // config (URL + credentials) and redirect its tool traffic.
  let ownerId = currentUser.id;
  if (server.id) {
    const existing = await mcpRepository.selectById(server.id);
    if (!existing) {
      throw new Error("MCP server not found");
    }
    const canManage = await canManageMCPServer(
      existing.userId,
      existing.visibility,
    );
    if (!canManage) {
      throw new Error(
        "You don't have permission to modify this MCP connection",
      );
    }
    // Preserve the original owner on update (e.g. admin editing a shared server).
    ownerId = existing.userId;
  }

  // Check for duplicate names if creating a featured server
  if (server.visibility === "public") {
    // Only admins can create featured MCP servers
    const canShare = await canShareMCPServer();
    if (!canShare) {
      throw new Error("Only administrators can feature MCP servers");
    }

    // Check if a featured server with this name already exists
    const existing = await mcpRepository.existsByServerName(server.name);
    if (existing && !server.id) {
      throw new Error("A featured MCP server with this name already exists");
    }
  }

  // Add userId to the server object
  const serverWithUser = {
    ...server,
    userId: ownerId,
    visibility: server.visibility || "private",
  };

  return mcpClientsManager.persistClient(serverWithUser);
}

export async function existMcpClientByServerNameAction(serverName: string) {
  return await mcpRepository.existsByServerName(serverName);
}

export async function removeMcpClientAction(id: string) {
  // Get the MCP server to check ownership
  const mcpServer = await mcpRepository.selectById(id);
  if (!mcpServer) {
    throw new Error("MCP server not found");
  }

  // Check if user has permission to delete this specific MCP server
  const canManage = await canManageMCPServer(
    mcpServer.userId,
    mcpServer.visibility,
  );
  if (!canManage) {
    throw new Error("You don't have permission to delete this MCP connection");
  }

  await mcpClientsManager.removeClient(id);
}

export async function refreshMcpClientAction(id: string) {
  await mcpClientsManager.refreshClient(id);
}

export async function authorizeMcpClientAction(id: string) {
  await refreshMcpClientAction(id);
  const client = await mcpClientsManager.getClient(id);
  if (client?.client.status != "authorizing") {
    throw new Error("Not Authorizing");
  }
  return client.client.getAuthorizationUrl()?.toString();
}

export async function checkTokenMcpClientAction(id: string) {
  const session = await mcpOAuthRepository.getAuthenticatedSession(id);

  // for wait connect to mcp server
  await mcpClientsManager.getClient(id).catch(() => null);

  return !!session?.tokens;
}

export async function callMcpToolAction(
  id: string,
  toolName: string,
  input: unknown,
) {
  return mcpClientsManager.toolCall(id, toolName, input);
}

export async function callMcpToolByServerNameAction(
  serverName: string,
  toolName: string,
  input: unknown,
) {
  return mcpClientsManager.toolCallByServerName(serverName, toolName, input);
}

export async function shareMcpServerAction(
  id: string,
  visibility: "public" | "private",
) {
  // Only admins can feature MCP servers
  const canShare = await canShareMCPServer();
  if (!canShare) {
    throw new Error("Only administrators can feature MCP servers");
  }

  // Update the visibility of the MCP server
  await mcpRepository.updateVisibility(id, visibility);

  return { success: true };
}
