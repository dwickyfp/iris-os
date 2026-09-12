import { type LanguageModel, smoothStream, streamText } from "ai";

import { type ChatModel } from "app-types/chat";
import { getSession } from "auth/server";
import { colorize } from "consola/utils";
import { customModelProvider } from "lib/ai/models";
import { CREATE_THREAD_TITLE_PROMPT } from "lib/ai/prompts";
import { chatRepository } from "lib/db/repository";
import globalLogger from "logger";
import { handleError } from "../shared.chat";

const logger = globalLogger.withDefaults({
  message: colorize("blackBright", `Title API: `),
});

export async function POST(request: Request) {
  try {
    const json = await request.json();

    const {
      message = "hello",
      threadId,
      model,
    } = json as {
      message: string;
      threadId: string;
      model?: ChatModel;
    };

    const session = await getSession();
    if (!session) {
      return new Response("Unauthorized", { status: 401 });
    }

    logger.info(`system engine: thread-title, threadId: ${threadId}`);

    // Inherit the caller's selected chat model; fall back to the default.
    let languageModel: LanguageModel;
    try {
      languageModel = await customModelProvider.getModel(model);
    } catch {
      languageModel = await customModelProvider.getEngineModel("thread-title");
    }

    const result = streamText({
      model: languageModel,
      instructions: CREATE_THREAD_TITLE_PROMPT,
      experimental_transform: smoothStream({ chunking: "word" }),
      prompt: message,
      abortSignal: request.signal,
      onEnd: (ctx) => {
        chatRepository
          .upsertThread({
            id: threadId,
            title: ctx.text,
            userId: session.user.id,
          })
          .catch((err) => logger.error(err));
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (err) {
    return new Response(handleError(err), { status: 500 });
  }
}
