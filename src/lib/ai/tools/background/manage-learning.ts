import { tool } from "ai";
import { z } from "zod";
import { LearningSettingsUpdateSchema } from "app-types/learning";
import {
  getLearningSettings,
  updateLearningSettings,
} from "lib/learning/settings";
import { hasExplicitLearningControlIntent } from "./intent";
export { MANAGE_LEARNING_TOOL_NAME } from "./names";

const InputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get") }),
  z.object({
    action: z.literal("update"),
    settings: LearningSettingsUpdateSchema.refine(
      (value) => Object.keys(value).length > 0,
      "At least one setting is required",
    ),
  }),
]);

export function createManageLearningTool(context: {
  userId: string;
  userText: string;
}) {
  return tool({
    description:
      "Read or update the current user's private background-learning policy only after an explicit request from that user.",
    inputSchema: InputSchema,
    execute: async (input) => {
      if (
        input.action === "update" &&
        !hasExplicitLearningControlIntent(context.userText)
      )
        throw new Error("EXPLICIT_LEARNING_CONTROL_INTENT_REQUIRED");
      const settings =
        input.action === "get"
          ? await getLearningSettings(context.userId)
          : await updateLearningSettings(context.userId, input.settings);
      return { ok: true, settings };
    },
  });
}
