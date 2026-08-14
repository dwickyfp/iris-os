import { jsonSchema, tool } from "ai";
import { and, eq } from "drizzle-orm";
import { createDelegatedRun, DELEGATION_LIMITS } from "lib/delegation/service";
import { pgDb } from "lib/db/pg/db.pg";
import { AgentRunTable } from "lib/db/pg/schema.pg";

export const DELEGATE_WORK_TOOL_NAME = "delegate_work";

type DelegateWorkInput = {
  childAgentId: string;
  objective: string;
  context?: Record<string, unknown>;
  timeoutMs?: number;
  tokenBudget?: number;
};

export function createDelegateWorkTool(input: {
  parentRunId: string;
  userId: string;
}) {
  return tool({
    description:
      "Delegate bounded work to a user-owned specialist agent and wait for its structured result.",
    inputSchema: jsonSchema<DelegateWorkInput>({
      type: "object",
      properties: {
        childAgentId: { type: "string", format: "uuid" },
        objective: { type: "string", minLength: 1, maxLength: 8_000 },
        context: { type: "object", additionalProperties: true },
        timeoutMs: {
          type: "integer",
          minimum: 1_000,
          maximum: DELEGATION_LIMITS.maxTimeoutMs,
        },
        tokenBudget: { type: "integer", minimum: 1_000, maximum: 200_000 },
      },
      required: ["childAgentId", "objective"],
      additionalProperties: false,
    }),
    execute: async (args: DelegateWorkInput) => {
      const {
        childAgentId,
        objective,
        context,
        timeoutMs,
        tokenBudget,
      } = args;
      const effectiveTimeout = timeoutMs ?? DELEGATION_LIMITS.defaultTimeoutMs;
      const delegated = await createDelegatedRun({
        userId: input.userId,
        parentRunId: input.parentRunId,
        childAgentId,
        objective,
        context: context ?? {},
        timeoutMs: effectiveTimeout,
        tokenBudget,
      });
      const deadline = Date.now() + effectiveTimeout;
      while (Date.now() < deadline) {
        const [run] = await pgDb
          .select()
          .from(AgentRunTable)
          .where(
            and(
              eq(AgentRunTable.id, delegated.childRunId),
              eq(AgentRunTable.userId, input.userId),
            ),
          );
        if (
          run &&
          ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)
        )
          return {
            childRunId: run.id,
            status: run.status,
            result: run.result,
            errorCode: run.errorCode,
            error: run.error,
          };
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await pgDb
        .update(AgentRunTable)
        .set({ cancelRequestedAt: new Date() })
        .where(eq(AgentRunTable.id, delegated.childRunId));
      return {
        childRunId: delegated.childRunId,
        status: "timed_out" as const,
        errorCode: "DELEGATION_WAIT_TIMED_OUT",
      };
    },
  });
}
