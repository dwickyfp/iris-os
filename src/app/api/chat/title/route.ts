import { smoothStream, streamText } from "ai";

import { customModelProvider } from "lib/ai/models";
import { CREATE_THREAD_TITLE_PROMPT } from "lib/ai/prompts";
import globalLogger from "logger";
import { chatRepository } from "lib/db/repository";
import { getSession } from "auth/server";
import { colorize } from "consola/utils";
import { handleError } from "../shared.chat";

const logger = globalLogger.withDefaults({
  message: colorize("blackBright", `Title API: `),
});

export async function POST(request: Request) {
  try {
    const json = await request.json();

    const { message = "hello", threadId } = json as {
      message: string;
      threadId: string;
    };

    const session = await getSession();
    if (!session) {
      return new Response("Unauthorized", { status: 401 });
    }

    logger.info(`system engine: thread-title, threadId: ${threadId}`);

    const result = streamText({
      model: await customModelProvider.getEngineModel("thread-title"),
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
