import { tool } from "ai";
import { z } from "zod";
import {
  AutomationCreateSchema,
  AutomationUpdateSchema,
} from "app-types/automation";
import {
  createManagedAutomation,
  listManagedAutomations,
  triggerManagedAutomation,
  updateManagedAutomation,
} from "lib/automation/management";
import { hasExplicitAutomationIntent } from "./intent";
export { MANAGE_AUTOMATION_TOOL_NAME } from "./names";

const InputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("create"), automation: AutomationCreateSchema }),
  z.object({
    action: z.literal("update"),
    automationId: z.string().uuid(),
    update: AutomationUpdateSchema,
  }),
  z.object({
    action: z.literal("pause"),
    automationId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("archive"),
    automationId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("trigger"),
    automationId: z.string().uuid(),
  }),
]);

export function createManageAutomationTool(context: {
  userId: string;
  userText: string;
}) {
  return tool({
    description:
      "Manage a user-owned automation only when the user explicitly asks. Never infer or create schedules from background patterns.",
    inputSchema: InputSchema,
    execute: async (input) => {
      if (
        input.action !== "list" &&
        !hasExplicitAutomationIntent(context.userText)
      )
        throw new Error("EXPLICIT_AUTOMATION_INTENT_REQUIRED");
      if (input.action === "list")
        return {
          ok: true,
          automations: await listManagedAutomations(context.userId),
        };
      if (input.action === "create")
        return {
          ok: true,
          automation: await createManagedAutomation(
            context.userId,
            input.automation,
          ),
        };
      if (input.action === "trigger")
        return {
          ok: true,
          run: await triggerManagedAutomation(
            context.userId,
            input.automationId,
          ),
        };
      const status = input.action === "update" ? undefined : input.action === "pause" ? "paused" : "archived";
      return {
        ok: true,
        automation: await updateManagedAutomation(
          context.userId,
          input.automationId,
          input.action === "update" ? input.update : { status },
        ),
      };
    },
  });
}
