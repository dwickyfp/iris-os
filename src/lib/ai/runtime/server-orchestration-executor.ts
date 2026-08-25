import "server-only";

import type { CapabilityDescriptor } from "./capabilities/registry";
import {
  type CapabilityConcurrency,
  type CapabilityScheduleResult,
  CapabilityScheduler,
} from "./capability-scheduler";
import {
  type CapabilityOrchestrationPlan,
  type OrchestrationPlanCall,
  type OrchestrationPlanCallResult,
  parseCapabilityOrchestrationPlan,
} from "./orchestration-plan";
import type { PolicyEvaluationDecision } from "./policy-engine";
import type { ResultSurface } from "./result-surface";

export const MAX_SERVER_ORCHESTRATION_CONCURRENCY = 8;

export type AuthorizedCapabilityDescriptor<TValue = unknown> = {
  capability: CapabilityDescriptor<TValue>;
  /** Server-resolved scheduling metadata. Plan input cannot override it. */
  concurrency: CapabilityConcurrency;
  approvalDecision: PolicyEvaluationDecision;
};

export type CanonicalCapabilityInvocation<TValue = unknown> = {
  callId: string;
  capability: CapabilityDescriptor<TValue>;
  input: unknown;
  approvalDecision: PolicyEvaluationDecision;
  signal?: AbortSignal;
};

export interface CanonicalCapabilityInvoker<
  TResult = unknown,
  TValue = unknown,
> {
  readonly handlesDurableApproval: boolean;
  invoke(
    invocation: CanonicalCapabilityInvocation<TValue>,
  ): TResult | Promise<TResult>;
}

export type ServerOrchestrationCommit = {
  call: OrchestrationPlanCall;
  descriptor: AuthorizedCapabilityDescriptor;
  result: CapabilityScheduleResult<ResultSurface>;
};

export type ServerOrchestrationExecutorOptions<TResult = unknown> = {
  maxConcurrency: number;
  authorizedDescriptors: ReadonlyMap<string, AuthorizedCapabilityDescriptor>;
  invoker: CanonicalCapabilityInvoker<TResult>;
  assertCurrentRevision: () => void | Promise<void>;
  projectResult: (
    result: TResult,
    context: {
      call: OrchestrationPlanCall;
      descriptor: AuthorizedCapabilityDescriptor;
    },
  ) => ResultSurface | Promise<ResultSurface>;
  onCommit?: (commit: ServerOrchestrationCommit) => void | Promise<void>;
  signal?: AbortSignal;
};

export class ServerOrchestrationAuthorityError extends Error {
  readonly name = "ServerOrchestrationAuthorityError";
}

export class ServerOrchestrationApprovalError extends Error {
  readonly name = "ServerOrchestrationApprovalError";
}

export class ServerOrchestrationExecutionError extends Error {
  readonly name = "ServerOrchestrationExecutionError";

  constructor(
    readonly callId: string,
    readonly cause: unknown,
  ) {
    super(`Orchestration call ${callId} did not complete`);
  }
}

function validateMaxConcurrency(maxConcurrency: number) {
  if (
    !Number.isSafeInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > MAX_SERVER_ORCHESTRATION_CONCURRENCY
  ) {
    throw new RangeError(
      `maxConcurrency must be an integer between 1 and ${MAX_SERVER_ORCHESTRATION_CONCURRENCY}`,
    );
  }
}

function authorizePlan(
  plan: CapabilityOrchestrationPlan,
  descriptors: ReadonlyMap<string, AuthorizedCapabilityDescriptor>,
  handlesDurableApproval: boolean,
) {
  const authorized = new Map<string, AuthorizedCapabilityDescriptor>();

  for (const step of plan.steps) {
    for (const call of step.calls) {
      const descriptor = descriptors.get(call.capabilityId);
      if (!descriptor) {
        throw new ServerOrchestrationAuthorityError(
          `Capability is not authorized: ${call.capabilityId}`,
        );
      }
      if (descriptor.capability.id !== call.capabilityId) {
        throw new ServerOrchestrationAuthorityError(
          `Authorized descriptor ID mismatch: ${call.capabilityId}`,
        );
      }
      if (descriptor.approvalDecision.capability.id !== call.capabilityId) {
        throw new ServerOrchestrationAuthorityError(
          `Approval decision capability mismatch: ${call.capabilityId}`,
        );
      }
      if (
        descriptor.concurrency !== "parallel" &&
        descriptor.concurrency !== "exclusive"
      ) {
        throw new ServerOrchestrationAuthorityError(
          `Invalid concurrency metadata: ${call.capabilityId}`,
        );
      }
      if (
        descriptor.approvalDecision.result !== "allow" &&
        descriptor.approvalDecision.result !== "deny" &&
        descriptor.approvalDecision.result !== "approval"
      ) {
        throw new ServerOrchestrationApprovalError(
          `Invalid approval decision: ${call.capabilityId}`,
        );
      }
      if (descriptor.approvalDecision.result === "deny") {
        throw new ServerOrchestrationApprovalError(
          `Capability was denied: ${call.capabilityId}`,
        );
      }
      if (
        descriptor.approvalDecision.result === "approval" &&
        handlesDurableApproval !== true
      ) {
        throw new ServerOrchestrationApprovalError(
          `Capability requires durable approval: ${call.capabilityId}`,
        );
      }
      authorized.set(call.id, descriptor);
    }
  }

  return authorized;
}

/** Executes a declarative plan through server-authorized canonical capabilities. */
export async function executeServerOrchestrationPlan<TResult>(
  value: unknown,
  options: ServerOrchestrationExecutorOptions<TResult>,
): Promise<OrchestrationPlanCallResult<ResultSurface>[]> {
  validateMaxConcurrency(options.maxConcurrency);
  const plan = parseCapabilityOrchestrationPlan(value);
  const authorized = authorizePlan(
    plan,
    options.authorizedDescriptors,
    options.invoker.handlesDurableApproval,
  );
  const scheduler = new CapabilityScheduler(options.maxConcurrency);
  const resolved = new Map<string, ResultSurface>();
  const orderedResults: OrchestrationPlanCallResult<ResultSurface>[] = [];

  for (const step of plan.steps) {
    const stepResults = await scheduler.schedule(
      step.calls.map((call) => {
        const descriptor = authorized.get(call.id)!;
        return {
          metadata: { concurrency: descriptor.concurrency },
          execute: async (signal?: AbortSignal) => {
            await options.assertCurrentRevision();
            const result = await options.invoker.invoke({
              callId: call.id,
              capability: descriptor.capability,
              input:
                call.inputFrom === undefined
                  ? call.input
                  : resolved.get(call.inputFrom),
              approvalDecision: descriptor.approvalDecision,
              signal,
            });
            return result;
          },
        };
      }),
      {
        signal: options.signal,
        onCommit: async (result, index) => {
          const call = step.calls[index];
          const descriptor = authorized.get(call.id)!;
          await options.assertCurrentRevision();

          let surfaceResult: CapabilityScheduleResult<ResultSurface>;
          if (result.status === "fulfilled") {
            try {
              const surface = await options.projectResult(result.value, {
                call,
                descriptor,
              });
              await options.assertCurrentRevision();
              resolved.set(call.id, surface);
              orderedResults.push({
                id: call.id,
                capabilityId: call.capabilityId,
                result: surface,
              });
              surfaceResult = { status: "fulfilled", value: surface };
            } catch (error) {
              surfaceResult = { status: "rejected", error };
            }
          } else {
            surfaceResult = result;
          }
          await options.onCommit?.({ call, descriptor, result: surfaceResult });
          if (surfaceResult.status !== "fulfilled") {
            throw new ServerOrchestrationExecutionError(
              call.id,
              surfaceResult.status === "rejected"
                ? surfaceResult.error
                : surfaceResult.reason,
            );
          }
        },
      },
    );

    const failedIndex = stepResults.findIndex(
      (result) => result.status !== "fulfilled",
    );
    if (failedIndex >= 0) {
      const result = stepResults[failedIndex];
      throw new ServerOrchestrationExecutionError(
        step.calls[failedIndex].id,
        result.status === "rejected"
          ? result.error
          : result.status === "skipped"
            ? result.reason
            : undefined,
      );
    }
  }

  return orderedResults;
}
