import type { UIMessage } from "ai";
import type { AgentRuntimeContext } from "../agent/runtime-context";
import type { RunBudget } from "./budget";
import type { ResolvedPolicySnapshot } from "./contracts";
import type { ContextEngine, ResolvedContext } from "./context-engine";
import type { PolicyAuthority } from "./policy-engine";
import type { CompletionRequirement } from "./verification";
import {
  type GoalCapability,
  type NormalizedGoalRequirement,
  goalRequirementResolver,
} from "./goal-requirement-resolver";

export type RunPreparationSnapshot = {
  context?: Pick<
    ResolvedContext,
    | "sourceRecords"
    | "estimatedTokens"
    | "truncatedSources"
    | "trustBoundaries"
    | "provenance"
    | "diagnostics"
  >;
  routing?: unknown;
  budget?: RunBudget;
  completion?: unknown;
  model?: unknown;
  driver?: unknown;
  sandbox?: unknown;
};

export type RunPreparationDependencies<Capabilities = unknown, Model = unknown> = {
  resolveCapabilities?(input: RunPreparationInput): Promise<{
    value: Capabilities;
    snapshot: unknown;
  }>;
  resolvePolicy?(input: {
    request: RunPreparationInput;
    capabilities?: Capabilities;
  }): Promise<ResolvedPolicySnapshot>;
  resolveBudget?(input: RunPreparationInput): Promise<RunBudget | undefined>;
  resolveRuntimeContext?(input: {
    request: RunPreparationInput;
    policy?: ResolvedPolicySnapshot;
    capabilities?: Capabilities;
  }): Promise<AgentRuntimeContext>;
  resolveCompletion?(input: RunPreparationInput): Promise<{
    requirement?: CompletionRequirement;
    snapshot?: unknown;
  }>;
  resolveModel?(input: RunPreparationInput): Promise<{
    value: Model;
    descriptor: unknown;
  }>;
  resolveDriver?(input: RunPreparationInput): Promise<{ descriptor: unknown }>;
  resolveSandbox?(input: RunPreparationInput): Promise<{
    ready: boolean;
    descriptor: unknown;
  }>;
};

export type RunPreparationInput = {
  surface?: "chat" | "automation" | "resume";
  userId?: string;
  workspaceId?: string;
  agentId?: string;
  request?: string;
  instructions?: string;
  messages?: UIMessage[];
  threadId?: string;
  contextWindow?: number;
  sources?: Parameters<ContextEngine["resolve"]>[0]["sources"];
  goal?: string;
  authority?: PolicyAuthority;
  restore?: RunPreparationSnapshot;
  selectedCapabilities?: GoalCapability[];
};

export type PreparedRun<Capabilities = unknown, Model = unknown> = {
  context: ResolvedContext;
  messages: UIMessage[];
  instructions: string;
  capabilities?: Capabilities;
  policy?: ResolvedPolicySnapshot;
  budget?: RunBudget;
  runtimeContext?: AgentRuntimeContext;
  completionRequirement?: CompletionRequirement;
  goalRequirement: NormalizedGoalRequirement;
  model?: Model;
  sandbox?: { ready: boolean; descriptor: unknown };
  snapshot: RunPreparationSnapshot;
};

/** Shared context/budget preparation for foreground, automation, and resume runs. */
export class RunPreparer<Capabilities = unknown, Model = unknown> {
  constructor(
    private readonly contextEngine: Pick<ContextEngine, "resolve">,
    private readonly dependencies: RunPreparationDependencies<
      Capabilities,
      Model
    > = {},
  ) {}

  async prepare(input: RunPreparationInput): Promise<PreparedRun<Capabilities, Model>> {
    const [context, capabilities, budget, completion, model, driver, sandbox] =
      await Promise.all([
        this.contextEngine.resolve({
          currentRequest: input.request,
          instructions: input.instructions,
          messages: input.messages,
          threadId: input.threadId,
          contextWindow: input.contextWindow,
          sources: input.sources,
        }),
        this.dependencies.resolveCapabilities?.(input),
        input.restore?.budget !== undefined
          ? input.restore.budget
          : this.dependencies.resolveBudget?.(input),
        this.dependencies.resolveCompletion?.(input),
        this.dependencies.resolveModel?.(input),
        this.dependencies.resolveDriver?.(input),
        this.dependencies.resolveSandbox?.(input),
      ]);
    const policy = await this.dependencies.resolvePolicy?.({
      request: input,
      capabilities: capabilities?.value,
    });
    const runtimeContext = await this.dependencies.resolveRuntimeContext?.({
      request: input,
      policy,
      capabilities: capabilities?.value,
    });
    const restoredRequirement = input.restore?.completion as
      | Partial<NormalizedGoalRequirement>
      | undefined;
    const goalRequirement =
      restoredRequirement?.level &&
      Array.isArray(restoredRequirement.requiredCapabilities)
        ? (restoredRequirement as NormalizedGoalRequirement)
        : goalRequirementResolver.resolve({
            goal: input.goal ?? input.request,
            selectedCapabilities: input.selectedCapabilities,
          });
    const contextSnapshot = {
      sourceRecords: [
        ...(input.restore?.context?.sourceRecords ?? []),
        ...context.sourceRecords,
      ],
      estimatedTokens: context.estimatedTokens,
      truncatedSources: [
        ...new Set([
          ...(input.restore?.context?.truncatedSources ?? []),
          ...context.truncatedSources,
        ]),
      ],
      trustBoundaries: [
        ...new Set([
          ...(input.restore?.context?.trustBoundaries ?? []),
          ...context.trustBoundaries,
        ]),
      ],
      provenance: [
        ...(input.restore?.context?.provenance ?? []),
        ...context.provenance,
      ],
      diagnostics: context.diagnostics,
    };
    return {
      context,
      messages: context.messages,
      instructions: context.instructions,
      capabilities: capabilities?.value,
      policy,
      budget,
      runtimeContext,
      completionRequirement: completion?.requirement,
      goalRequirement,
      model: model?.value,
      sandbox,
      snapshot: {
        context: contextSnapshot,
        routing: input.restore?.routing ?? capabilities?.snapshot,
        budget,
        completion:
          input.restore?.completion ?? completion?.snapshot ?? goalRequirement,
        model: input.restore?.model ?? model?.descriptor,
        driver: input.restore?.driver ?? driver?.descriptor,
        sandbox: input.restore?.sandbox ?? sandbox?.descriptor,
      },
    };
  }
}
