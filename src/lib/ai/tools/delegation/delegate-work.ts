import { jsonSchema, tool } from "ai";
import { createDelegatedRun, DELEGATION_LIMITS } from "lib/delegation/service";
import {
  delegationTargetId,
  type DelegationTarget,
} from "lib/delegation/targets";

export const DELEGATE_AGENT_TOOL_NAME = "delegate_agent";
export const DELEGATE_WORK_TOOL_NAME = DELEGATE_AGENT_TOOL_NAME;

type DelegateWorkInput = {
  target: string;
  objective: string;
  context?: Record<string, unknown>;
  timeoutMs?: number;
  tokenBudget?: number;
};

export function createDelegateWorkTool(input: {
  parentRunId: string;
  userId: string;
  targets: readonly DelegationTarget[];
}) {
  const targets = new Map(
    input.targets.map((target) => [delegationTargetId(target), target]),
  );
  return tool({
    description: `Delegate a bounded subproblem to one eligible specialist. Targets: ${input.targets
      .map((target) => `${delegationTargetId(target)} (${target.name})`)
      .join(", ")}.`,
    inputSchema: jsonSchema<DelegateWorkInput>({
      type: "object",
      properties: {
        target: { type: "string", enum: [...targets.keys()] },
        objective: { type: "string", minLength: 1, maxLength: 8_000 },
        context: { type: "object", additionalProperties: true },
        timeoutMs: {
          type: "integer",
          minimum: 1_000,
          maximum: DELEGATION_LIMITS.maxTimeoutMs,
        },
        tokenBudget: { type: "integer", minimum: 1_000, maximum: 200_000 },
      },
      required: ["target", "objective"],
      additionalProperties: false,
    }),
    execute: async (args: DelegateWorkInput, options) => {
      const { objective, context, timeoutMs, tokenBudget } = args;
      const targetId = args.target;
      const target = targets.get(targetId);
      if (!target) throw new Error("DELEGATION_TARGET_NOT_ELIGIBLE");
      const effectiveTimeout = timeoutMs ?? DELEGATION_LIMITS.defaultTimeoutMs;
      const delegated = await createDelegatedRun({
        userId: input.userId,
        parentRunId: input.parentRunId,
        agentRef:
          target.kind === "local"
            ? { kind: "local", agentId: target.agentId }
            : { kind: "remote", connectionId: target.connectionId },
        objective,
        context: context ?? {},
        timeoutMs: effectiveTimeout,
        tokenBudget,
        toolCallId: options.toolCallId,
        idempotencyKey: `${input.parentRunId}:${options.toolCallId}`,
      });
      return {
        childRunId: delegated.childRunId,
        status: "accepted" as const,
      };
    },
  });
}
