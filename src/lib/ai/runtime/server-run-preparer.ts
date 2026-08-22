import "server-only";

import { contextEngine } from "lib/ai/context-compaction";
import { createGoalVerificationRequirement } from "lib/ai/artifacts/default-verification.server";
import { goalRequirementResolver } from "./goal-requirement-resolver";
import { type RunPreparationDependencies, RunPreparer } from "./run-preparer";
import { serverBudgetResolver } from "./server-budget-resolver";

type ServerRunSurfaceBindings<Capabilities, Model> = Pick<
  RunPreparationDependencies<Capabilities, Model>,
  | "resolveCapabilities"
  | "resolvePolicy"
  | "resolveRuntimeContext"
  | "resolveModel"
> & {
  /** Narrow authority injection for claimed descendants and isolated tests. */
  resolveBudget?: RunPreparationDependencies<Capabilities, Model>["resolveBudget"];
};

/** Canonical server factory for chat, automation, delegation, and resume preparation. */
export function serverRunPreparer<Capabilities = unknown, Model = unknown>(
  bindings: ServerRunSurfaceBindings<Capabilities, Model> = {},
) {
  return new RunPreparer(contextEngine, {
    ...bindings,
    resolveBudget: bindings.resolveBudget ?? serverBudgetResolver,
    resolveCompletion: async (input) => {
      const requirement = goalRequirementResolver.resolve({
        goal: input.goal ?? input.request,
        selectedCapabilities: input.selectedCapabilities,
      });
      return {
        requirement: createGoalVerificationRequirement(requirement),
        snapshot: requirement,
      };
    },
    resolveDriver: async () => ({ descriptor: { id: "ai-sdk" } }),
  });
}
