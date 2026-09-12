import { mcpOAuthRepository } from "@/lib/db/repository";
import { mcpClientsManager } from "lib/ai/mcp/mcp-manager";
import { NextRequest } from "next/server";

import { colorize } from "consola/utils";
import globalLogger from "logger";
import { createOAuthResponsePage } from "./oauth-response-page";

const logger = globalLogger.withDefaults({
  message: colorize("bgGreen", `MCP OAuth Callback: `),
});

/**
 * OAuth callback endpoint for MCP servers
 * Handles the authorization code exchange and token storage
 */
export async function GET(request: NextRequest) {
  logger.info("OAuth callback received Authorization Code");
  const { searchParams } = new URL(request.url);

  const callbackData = {
    code: searchParams.get("code") || undefined,
    state: searchParams.get("state") || undefined,
    error: searchParams.get("error") || undefined,
    error_description: searchParams.get("error_description") || undefined,
  };

  // Handle OAuth error responses
  if (callbackData.error) {
    return createOAuthResponsePage({
      type: "error",
      title: "OAuth Error",
      heading: "Authentication Failed",
      message: `Error: ${callbackData.error} — ${
        callbackData.error_description || "Unknown error occurred"
      }`,
      postMessageType: "MCP_OAUTH_ERROR",
      postMessageData: {
        error: callbackData.error,
        error_description: callbackData.error_description || "Unknown error",
      },
      statusCode: 400,
    });
  }

  // Validate required parameters
  if (!callbackData.code || !callbackData.state) {
    return createOAuthResponsePage({
      type: "error",
      title: "OAuth Error",
      heading: "Authentication Failed",
      message: "Missing required parameters",
      postMessageType: "MCP_OAUTH_ERROR",
      postMessageData: {
        error: "invalid_request",
        error_description: "Missing authorization code or state parameter",
      },
      statusCode: 400,
    });
  }

  // Find the OAuth session by state
  const session = await mcpOAuthRepository.getSessionByState(
    callbackData.state,
  );
  if (!session) {
    return createOAuthResponsePage({
      type: "error",
      title: "OAuth Error",
      heading: "Authentication Failed",
      message: "Invalid or expired session",
      postMessageType: "MCP_OAUTH_ERROR",
      postMessageData: {
        error: "invalid_state",
        error_description: "Invalid or expired state parameter",
      },
      statusCode: 400,
    });
  }

  const client = await mcpClientsManager.getClient(session.mcpServerId);

  try {
    await client?.client.finishAuth(callbackData.code, callbackData.state);
    await mcpClientsManager.refreshClient(session.mcpServerId);

    return createOAuthResponsePage({
      type: "success",
      title: "OAuth Success",
      heading: "Authentication Successful!",
      message: "You can now close this window.",
      postMessageType: "MCP_OAUTH_SUCCESS",
      postMessageData: {
        success: true,
      },
      statusCode: 200,
    });
  } catch (error: any) {
    logger.error("OAuth callback failed", error);
    return createOAuthResponsePage({
      type: "error",
      title: "OAuth Error",
      heading: "Authentication Failed",
      message: error.message || "Failed to complete the authentication process",
      postMessageType: "MCP_OAUTH_ERROR",
      postMessageData: {
        error: "auth_failed",
        error_description: "Failed to complete authentication",
      },
      statusCode: 500,
    });
  }
}
