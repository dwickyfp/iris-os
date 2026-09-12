import { VercelAIMcpTool } from "app-types/mcp";
import { getSession } from "auth/server";
import {
  buildMcpServerCustomizationsSystemPrompt,
  buildSpeechSystemPrompt,
} from "lib/ai/prompts";
import { NextRequest } from "next/server";
import {
  filterMcpServerCustomizations,
  loadMcpTools,
  mergeSystemPrompt,
} from "../shared.chat";

import { ChatMention } from "app-types/chat";
import { colorize } from "consola/utils";
import { resolveConfiguredProviderCredential } from "lib/ai/provider-credentials.server";
import { DEFAULT_VOICE_TOOLS } from "lib/ai/speech";
import globalLogger from "lib/logger";
import { getUserPreferences } from "lib/user/server";
import { safe } from "ts-safe";
import {
  rememberAgentAction,
  rememberMcpServerCustomizationsAction,
} from "../actions";

const logger = globalLogger.withDefaults({
  message: colorize("blackBright", `OpenAI Realtime API: `),
});

export async function POST(request: NextRequest) {
  try {
    const { apiKey, provider } = await resolveConfiguredProviderCredential(
      "providers.realtimeProviderId",
    );
    if (provider.type !== "openai")
      return Response.json(
        { error: "Configured realtime provider must be OpenAI" },
        { status: 400 },
      );

    const session = await getSession();

    if (!session?.user.id) {
      return new Response("Unauthorized", { status: 401 });
    }

    const { voice, mentions, agentId } = (await request.json()) as {
      model: string;
      voice: string;
      agentId?: string;
      mentions: ChatMention[];
    };

    const agent = await rememberAgentAction(agentId, session.user.id);

    agentId && logger.info(`[${agentId}] Agent: ${agent?.name}`);

    const enabledMentions = agent ? agent.instructions.mentions : mentions;

    const allowedMcpTools = await loadMcpTools({
      userId: session.user.id,
      mentions: enabledMentions,
    });

    const toolNames = Object.keys(allowedMcpTools ?? {});

    if (toolNames.length > 0) {
      logger.info(`${toolNames.length} tools found`);
    } else {
      logger.info(`No tools found`);
    }

    const userPreferences = await getUserPreferences(session.user.id);

    const mcpServerCustomizations = await safe()
      .map(() => {
        if (Object.keys(allowedMcpTools ?? {}).length === 0)
          throw new Error("No tools found");
        return rememberMcpServerCustomizationsAction(session.user.id);
      })
      .map((v) => filterMcpServerCustomizations(allowedMcpTools!, v))
      .orElse({});

    const openAITools = Object.entries(allowedMcpTools ?? {}).map(
      ([name, tool]) => {
        return vercelAIToolToOpenAITool(tool, name);
      },
    );

    const systemPrompt = mergeSystemPrompt(
      buildSpeechSystemPrompt(
        session.user,
        userPreferences ?? undefined,
        agent,
      ),
      buildMcpServerCustomizationsSystemPrompt(mcpServerCustomizations),
    );

    const bindingTools = [...openAITools, ...DEFAULT_VOICE_TOOLS];

    const endpoint = new URL(
      "realtime/sessions",
      `${provider.baseUrl ?? "https://api.openai.com/v1"}/`,
    );
    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        model: "gpt-4o-realtime-preview",
        voice: voice || "alloy",
        input_audio_transcription: {
          model: "whisper-1",
        },
        instructions: systemPrompt,
        tools: bindingTools,
      }),
    });

    return new Response(r.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error: any) {
    console.error("Error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
    });
  }
}

function vercelAIToolToOpenAITool(tool: VercelAIMcpTool, name: string) {
  return {
    name,
    type: "function",
    description: tool.description,
    parameters: (tool.inputSchema as any).jsonSchema ?? {
      type: "object",
      properties: {},
      required: [],
    },
  };
}
