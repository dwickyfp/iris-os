import "server-only";

import type {
  AgentRuntimeContext,
  ApprovalPolicy,
} from "../agent/runtime-context";
import type { RunBudget } from "./budget";
import type { ResolvedPolicySnapshot } from "./contracts";
import type { GoalCapability } from "./goal-requirement-resolver";
import {
  type PolicyAuthority,
  type PolicyCapability,
  intersectPolicyAuthority,
  policyEngine,
} from "./policy-engine";
import type {
  PreparedRun,
  RunPreparationDependencies,
  RunPreparationInput,
} from "./run-preparer";
import {
  type ServerRunSurfaceBindings,
  serverRunPreparer,
} from "./server-run-preparer";

export type ProductionCapabilitySet<Value> = {
  value: Value;
  tools: Record<string, unknown>;
  descriptors: PolicyCapability[];
  selectedCapabilities: GoalCapability[];
  routing: Record<string, unknown>;
};

type ProfileCapabilitySubtraction = {
  id: string;
  key: string;
  reason: "outside_profile_authority" | "tool_allowlist";
};

type BaseProductionProfile = {
  approvalPolicy: ApprovalPolicy;
  authority?: PolicyAuthority;
};

export type ChatPreparationProfile = BaseProductionProfile & {
  surface: "chat";
};

export type AutomationPreparationProfile = BaseProductionProfile & {
  surface: "automation";
  allowedToolKeys?: readonly string[];
};

export type DelegationPreparationProfile = BaseProductionProfile & {
  surface: "delegation";
  allowedToolKeys: readonly string[];
  childAllocation: {
    authority: PolicyAuthority;
    budget?: RunBudget;
  };
};

export type ResumePreparationProfile = BaseProductionProfile & {
  surface: "resume";
  persistedPolicy: ResolvedPolicySnapshot;
};

export type ProductionPreparationProfile =
  | ChatPreparationProfile
  | AutomationPreparationProfile
  | DelegationPreparationProfile
  | ResumePreparationProfile;

type AdapterDependencies<CapabilityInput, Capabilities, Model> = {
  resolveCapabilities(
    input: CapabilityInput,
  ): Promise<ProductionCapabilitySet<Capabilities>>;
  resolveRuntimeContext(input: {
    request: RunPreparationInput;
    policy: ResolvedPolicySnapshot;
    capabilities: Capabilities;
  }): Promise<AgentRuntimeContext>;
  resolveModel(
    input: RunPreparationInput,
  ): Promise<{ value: Model; descriptor: unknown }>;
  resolveBudget?: RunPreparationDependencies<
    Capabilities,
    Model
  >["resolveBudget"];
  createPreparer?: (
    bindings: ServerRunSurfaceBindings<Capabilities, Model>,
  ) => {
    prepare(
      input: RunPreparationInput,
    ): Promise<PreparedRun<Capabilities, Model>>;
  };
};

export type ProductionRunAdapter<CapabilityInput, Capabilities, Model> = {
  readonly profile: ProductionPreparationProfile;
  resolveCapabilities(
    input: CapabilityInput,
  ): Promise<ProductionCapabilitySet<Capabilities>>;
  prepare(input: {
    capabilities: ProductionCapabilitySet<Capabilities>;
    request: Omit<
      RunPreparationInput,
      "surface" | "authority" | "selectedCapabilities"
    >;
  }): Promise<PreparedRun<Capabilities, Model>>;
};

function profileAuthority(profile: ProductionPreparationProfile) {
  const own = profile.authority ?? {};
  if (profile.surface === "delegation")
    return intersectPolicyAuthority(own, profile.childAllocation.authority);
  if (profile.surface === "resume")
    return intersectPolicyAuthority(
      profile.persistedPolicy.authority ?? {},
      own,
    );
  return own;
}

function constrainCapabilities<Value>(
  capabilities: ProductionCapabilitySet<Value>,
  profile: ProductionPreparationProfile,
) {
  const authority = profileAuthority(profile);
  const authorityIds = authority.capabilityIds
    ? new Set(authority.capabilityIds)
    : undefined;
  const allowedKeys =
    (profile.surface === "automation" && profile.allowedToolKeys !== undefined) ||
    profile.surface === "delegation"
      ? new Set(profile.allowedToolKeys)
      : undefined;
  const descriptors = capabilities.descriptors.filter(
    ({ id, key }) =>
      (!authorityIds || authorityIds.has(id)) &&
      (!allowedKeys || allowedKeys.has(key)),
  );
  const descriptorKeys = new Set(descriptors.map(({ key }) => key));
  const tools = Object.fromEntries(
    Object.entries(capabilities.tools).filter(([key]) =>
      descriptorKeys.has(key),
    ),
  );
  const subtractions = capabilities.descriptors
    .filter(
      ({ id, key }) =>
        (authorityIds !== undefined && !authorityIds.has(id)) ||
        (allowedKeys !== undefined && !allowedKeys.has(key)),
    )
    .flatMap(({ id, key }): ProfileCapabilitySubtraction[] => {
      if (authorityIds && !authorityIds.has(id))
        return [{ id, key, reason: "outside_profile_authority" as const }];
      if (allowedKeys && !allowedKeys.has(key))
        return [{ id, key, reason: "tool_allowlist" as const }];
      return [];
    });
  return {
    ...capabilities,
    tools,
    descriptors,
    selectedCapabilities: descriptors,
    routing: {
      ...capabilities.routing,
      descriptorIds: descriptors.map(({ id }) => id),
      ...(subtractions.length ? { subtractions } : {}),
    },
  };
}

function resolvePolicy(
  profile: ProductionPreparationProfile,
  capabilities: ProductionCapabilitySet<unknown>,
): ResolvedPolicySnapshot {
  const resolved = policyEngine.resolveSnapshot(
    Object.keys(capabilities.tools),
    profile.approvalPolicy,
    capabilities.descriptors,
  );
  const authority = intersectPolicyAuthority(
    resolved.authority ?? {},
    profileAuthority(profile),
  );
  if (profile.surface !== "resume") return { ...resolved, authority };
  return {
    ...resolved,
    approvalPolicy: profile.persistedPolicy.approvalPolicy,
    authority,
  };
}

/** Canonical production binding shared by all server execution surfaces. */
export function createProductionRunAdapter<
  CapabilityInput,
  Capabilities,
  Model,
>(
  profile: ProductionPreparationProfile,
  dependencies: AdapterDependencies<CapabilityInput, Capabilities, Model>,
): ProductionRunAdapter<CapabilityInput, Capabilities, Model> {
  return {
    profile,
    async resolveCapabilities(input) {
      return constrainCapabilities(
        await dependencies.resolveCapabilities(input),
        profile,
      );
    },
    async prepare({ capabilities, request }) {
      const policy = resolvePolicy(profile, capabilities);
      const resolveBudget =
        profile.surface === "delegation" && profile.childAllocation.budget
          ? async (input: RunPreparationInput) =>
              dependencies.resolveBudget
                ? dependencies.resolveBudget({
                    ...input,
                    requestedBudget: profile.childAllocation.budget,
                  })
                : profile.childAllocation.budget
          : dependencies.resolveBudget;
      const preparer = (dependencies.createPreparer ?? serverRunPreparer)({
        resolveCapabilities: async () => ({
          value: capabilities.value,
          snapshot: capabilities.routing,
        }),
        resolvePolicy: async () => policy,
        resolveRuntimeContext: async ({ request: preparationRequest }) =>
          dependencies.resolveRuntimeContext({
            request: preparationRequest,
            policy,
            capabilities: capabilities.value,
          }),
        resolveModel: dependencies.resolveModel,
        resolveBudget,
      });
      return preparer.prepare({
        ...request,
        surface: profile.surface,
        authority: profileAuthority(profile),
        selectedCapabilities: capabilities.selectedCapabilities,
      });
    },
  };
}
