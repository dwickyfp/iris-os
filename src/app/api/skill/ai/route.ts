import { streamObject } from "ai";
import { z } from "zod";

import { ChatModel } from "app-types/chat";
import { SkillGenerateSchema } from "app-types/skill";
import { getSession } from "auth/server";
import { customModelProvider } from "lib/ai/models";
import { buildSkillGenerationPrompt } from "lib/ai/prompts";
import { canCreateSkill } from "lib/auth/permissions";
import globalLogger from "logger";

const logger = globalLogger.withDefaults({
  message: "Skill Generate API: ",
});

const SkillGenerationRequestSchema = z.object({
  message: z.string().trim().min(1).max(10_000),
  chatModel: z.custom<ChatModel>().optional(),
});

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session?.user.id) return new Response("Unauthorized", { status: 401 });
    if (!(await canCreateSkill())) {
      return new Response("Forbidden", { status: 403 });
    }

    const { chatModel, message } = SkillGenerationRequestSchema.parse(
      await request.json(),
    );
    const result = streamObject({
      model: await customModelProvider.getModel(chatModel),
      instructions: buildSkillGenerationPrompt(),
      prompt: message,
      schema: SkillGenerateSchema,
    });

    return result.toTextStreamResponse();
  } catch (error) {
    logger.error(error);
    return new Response("Unable to generate skill", { status: 500 });
  }
}
