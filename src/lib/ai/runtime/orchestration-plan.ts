import { z } from "zod";

const identifierSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => value.trim().length > 0, "Identifier cannot be blank");

export const orchestrationPlanCallSchema = z
  .object({
    id: identifierSchema,
    capabilityId: identifierSchema,
    input: z.unknown().optional(),
    inputFrom: identifierSchema.optional(),
  })
  .strict()
  .refine(
    (call) => call.input === undefined || call.inputFrom === undefined,
    "A call cannot declare both input and inputFrom",
  );

export const orchestrationPlanStepSchema = z
  .object({
    calls: z.array(orchestrationPlanCallSchema).min(1).max(16),
  })
  .strict();

export const capabilityOrchestrationPlanSchema = z
  .object({
    version: z.literal(1),
    steps: z.array(orchestrationPlanStepSchema).min(1).max(10),
  })
  .strict();

export type OrchestrationPlanCall = z.infer<typeof orchestrationPlanCallSchema>;
export type OrchestrationPlanStep = z.infer<typeof orchestrationPlanStepSchema>;
export type CapabilityOrchestrationPlan = z.infer<
  typeof capabilityOrchestrationPlanSchema
>;

export type CapabilityInvocation = {
  capabilityId: string;
  input: unknown;
  signal?: AbortSignal;
};

export type CanonicalCapabilityInvoke<TResult = unknown> = (
  invocation: CapabilityInvocation,
) => TResult | Promise<TResult>;

export type OrchestrationPlanCallResult<TResult = unknown> = {
  id: string;
  capabilityId: string;
  result: TResult;
};

export class OrchestrationPlanDependencyError extends Error {
  readonly name = "OrchestrationPlanDependencyError";
}

function validateDependencies(plan: CapabilityOrchestrationPlan) {
  const calls = new Map<
    string,
    { call: OrchestrationPlanCall; stepIndex: number }
  >();

  for (const [stepIndex, step] of plan.steps.entries()) {
    for (const call of step.calls) {
      if (calls.has(call.id)) {
        throw new OrchestrationPlanDependencyError(
          `Duplicate call id: ${call.id}`,
        );
      }
      calls.set(call.id, { call, stepIndex });
    }
  }

  for (const { call } of calls.values()) {
    if (call.inputFrom !== undefined && !calls.has(call.inputFrom)) {
      throw new OrchestrationPlanDependencyError(
        `Call ${call.id} depends on missing call ${call.inputFrom}`,
      );
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string) => {
    if (visiting.has(id)) {
      throw new OrchestrationPlanDependencyError(
        `Dependency cycle detected at call ${id}`,
      );
    }
    if (visited.has(id)) return;

    visiting.add(id);
    const dependency = calls.get(id)?.call.inputFrom;
    if (dependency !== undefined) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of calls.keys()) visit(id);

  for (const { call, stepIndex } of calls.values()) {
    if (call.inputFrom === undefined) continue;
    const dependencyStep = calls.get(call.inputFrom)?.stepIndex;
    if (dependencyStep !== undefined && dependencyStep >= stepIndex) {
      throw new OrchestrationPlanDependencyError(
        `Call ${call.id} must depend on a call from an earlier step`,
      );
    }
  }
}

export function parseCapabilityOrchestrationPlan(
  value: unknown,
): CapabilityOrchestrationPlan {
  const plan = capabilityOrchestrationPlanSchema.parse(value);
  validateDependencies(plan);
  return plan;
}

/** Executes parallel calls within each sequential step. */
export async function executeCapabilityOrchestrationPlan<TResult>(
  value: unknown,
  invoke: CanonicalCapabilityInvoke<TResult>,
): Promise<OrchestrationPlanCallResult<TResult>[]> {
  const plan = parseCapabilityOrchestrationPlan(value);
  const resolved = new Map<string, TResult>();
  const orderedResults: OrchestrationPlanCallResult<TResult>[] = [];

  for (const step of plan.steps) {
    const stepResults = await Promise.all(
      step.calls.map(async (call) => {
        const input =
          call.inputFrom === undefined
            ? call.input
            : resolved.get(call.inputFrom);
        const result = await invoke({
          capabilityId: call.capabilityId,
          input,
        });
        return { id: call.id, capabilityId: call.capabilityId, result };
      }),
    );

    for (const callResult of stepResults) {
      resolved.set(callResult.id, callResult.result);
      orderedResults.push(callResult);
    }
  }

  return orderedResults;
}
