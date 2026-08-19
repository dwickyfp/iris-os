import { createHash } from "node:crypto";
import { DefaultToolName, ImageToolName } from "lib/ai/tools";
import type { ApprovalPolicy } from "../agent/runtime-context";
import { SKILLS_LIST_TOOL_NAME, SKILL_VIEW_TOOL_NAME } from "../skill";
import { MANAGE_LEARNING_TOOL_NAME } from "../tools/background/names";
import type { ResolvedPolicySnapshot } from "./contracts";

export type PolicyRisk =
  | "read"
  | "write"
  | "destructive"
  | "network"
  | "code"
  | "remote";

export type PolicyActor = {
  type: "user" | "agent" | "system";
  id?: string;
  userId?: string;
};

export type PolicyCapability = {
  id: string;
  key: string;
  kind?: string;
  /** Additive trusted metadata. It can increase risk, never suppress inference. */
  risks?: readonly PolicyRisk[];
};

export type PolicyDestination = {
  kind: "local" | "remote" | "network";
  id?: string;
  uri?: string;
};

export type PolicyAuthority = {
  capabilityIds?: string[];
  actions?: string[];
  destinationKinds?: PolicyDestination["kind"][];
  maximumRisks?: PolicyRisk[];
};

export type PolicyEvaluationInput = {
  actor: PolicyActor;
  capability: PolicyCapability;
  action: string;
  resource: string;
  args: unknown;
  destination: PolicyDestination;
  runtime: {
    kind: "foreground" | "local_delegation" | "remote_delegation" | "worker";
    approvalPolicy: ApprovalPolicy;
    runId?: string;
    parentRunId?: string;
    authority?: PolicyAuthority;
  };
};

export type PolicyResult = "allow" | "deny" | "approval";

export type PolicyEvaluationDecision = {
  version: 2;
  decisionId: string;
  result: PolicyResult;
  risks: PolicyRisk[];
  reasons: string[];
  actor: PolicyActor;
  capability: PolicyCapability;
  action: string;
  resource: string;
  destination: PolicyDestination;
  runtime: Omit<PolicyEvaluationInput["runtime"], "authority">;
};

export type PolicyDecision = {
  toolName: string;
  readOnly: boolean;
  requiresApproval: boolean;
  reason: "explicit_low_risk" | "read_only" | "high_risk" | "unclassified";
  risks?: PolicyRisk[];
};

export type AutonomyMode = "standard" | "ask" | "off";

const EXPLICIT_LOW_RISK_TOOL_NAMES = new Set<string>([
  MANAGE_LEARNING_TOOL_NAME,
]);
const READ_ONLY_TOOL_NAMES = new Set<string>([
  DefaultToolName.WebSearch,
  DefaultToolName.WebContent,
  DefaultToolName.CreatePieChart,
  DefaultToolName.CreateBarChart,
  DefaultToolName.CreateLineChart,
  DefaultToolName.CreateTable,
  SKILLS_LIST_TOOL_NAME,
  SKILL_VIEW_TOOL_NAME,
]);
const HIGH_RISK_TOOL_NAMES = new Set<string>([
  DefaultToolName.Http,
  DefaultToolName.JavascriptExecution,
  DefaultToolName.PythonExecution,
  ImageToolName,
]);
const RISK_ORDER: PolicyRisk[] = [
  "read",
  "write",
  "destructive",
  "network",
  "code",
  "remote",
];

export function classifyToolName(toolName: string): PolicyRisk[] {
  if (READ_ONLY_TOOL_NAMES.has(toolName))
    return toolName === DefaultToolName.WebSearch ||
      toolName === DefaultToolName.WebContent
      ? ["read", "network"]
      : ["read"];
  if (
    toolName === DefaultToolName.JavascriptExecution ||
    toolName === DefaultToolName.PythonExecution
  )
    return ["write", "code"];
  if (toolName === DefaultToolName.Http) return ["write", "network"];
  return ["write"];
}

export function destinationFromArgs(args: unknown): PolicyDestination {
  if (!args || typeof args !== "object") return { kind: "local" };
  const record = args as Record<string, unknown>;
  const uri = [
    record.url,
    record.uri,
    record.endpoint,
    record.destination,
  ].find((value): value is string => typeof value === "string");
  return uri && /^(https?|wss?):\/\//i.test(uri)
    ? { kind: "network", uri }
    : { kind: "local" };
}

function inferredRisks(input: PolicyEvaluationInput) {
  const text = `${input.action} ${input.resource}`.toLowerCase();
  const risks = new Set<PolicyRisk>(
    input.capability.risks ??
      (input.capability.id.startsWith("tool:")
        ? classifyToolName(input.capability.key)
        : []),
  );
  if (/delete|destroy|drop|erase|revoke|terminate|cancel/.test(text))
    risks.add("destructive");
  if (/write|create|update|send|publish|execute|run|delegate|upload/.test(text))
    risks.add("write");
  if (/eval|script|javascript|python|code/.test(text)) risks.add("code");
  if (/read|get|list|search|view|inspect|download/.test(text))
    risks.add("read");
  if (input.destination.kind === "network") risks.add("network");
  if (input.destination.kind === "remote") risks.add("remote");
  if (risks.size === 0) risks.add("write");
  return RISK_ORDER.filter((risk) => risks.has(risk));
}

function authorityDenials(
  input: PolicyEvaluationInput,
  risks: readonly PolicyRisk[],
) {
  const authority = input.runtime.authority;
  if (!authority) return [];
  const reasons: string[] = [];
  if (
    authority.capabilityIds &&
    !authority.capabilityIds.includes(input.capability.id)
  )
    reasons.push("capability_outside_authority");
  if (authority.actions && !authority.actions.includes(input.action))
    reasons.push("action_outside_authority");
  if (
    authority.destinationKinds &&
    !authority.destinationKinds.includes(input.destination.kind)
  )
    reasons.push("destination_outside_authority");
  if (
    authority.maximumRisks &&
    risks.some((risk) => !authority.maximumRisks?.includes(risk))
  )
    reasons.push("risk_outside_authority");
  return reasons;
}

export function intersectPolicyAuthority(
  parent: PolicyAuthority,
  child: PolicyAuthority,
): PolicyAuthority {
  const intersect = <T extends string>(left?: T[], right?: T[]) => {
    if (!left) return right ? [...new Set(right)] : undefined;
    if (!right) return [...new Set(left)];
    const allowed = new Set(right);
    return [...new Set(left)].filter((value) => allowed.has(value));
  };
  return {
    capabilityIds: intersect(parent.capabilityIds, child.capabilityIds),
    actions: intersect(parent.actions, child.actions),
    destinationKinds: intersect(
      parent.destinationKinds,
      child.destinationKinds,
    ),
    maximumRisks: intersect(parent.maximumRisks, child.maximumRisks),
  };
}

export class PolicyEngine {
  evaluate(input: PolicyEvaluationInput): PolicyEvaluationDecision {
    const risks = inferredRisks(input);
    const denied = authorityDenials(input, risks);
    const risky = risks.some((risk) => risk !== "read");
    const result: PolicyResult = denied.length
      ? "deny"
      : input.runtime.approvalPolicy === "always" ||
          (input.runtime.approvalPolicy === "destructive_only" && risky)
        ? "approval"
        : "allow";
    const reasons = denied.length
      ? denied
      : result === "approval"
        ? risks.filter((risk) => risk !== "read").map((risk) => `${risk}_risk`)
        : [risky ? "approval_disabled" : "read_only"];
    const observable = {
      version: 2 as const,
      result,
      risks,
      reasons,
      actor: input.actor,
      capability: input.capability,
      action: input.action,
      resource: input.resource,
      destination: input.destination,
      runtime: {
        kind: input.runtime.kind,
        approvalPolicy: input.runtime.approvalPolicy,
        runId: input.runtime.runId,
        parentRunId: input.runtime.parentRunId,
      },
    };
    return {
      ...observable,
      decisionId: createHash("sha256")
        .update(JSON.stringify(observable))
        .digest("hex")
        .slice(0, 24),
    };
  }

  /** Compatibility adapter for callers that only know a runtime tool name. */
  evaluateTool(toolName: string): PolicyDecision {
    if (EXPLICIT_LOW_RISK_TOOL_NAMES.has(toolName))
      return {
        toolName,
        readOnly: false,
        requiresApproval: false,
        reason: "explicit_low_risk",
      };
    if (READ_ONLY_TOOL_NAMES.has(toolName))
      return {
        toolName,
        readOnly: true,
        requiresApproval: false,
        reason: "read_only",
      };
    return {
      toolName,
      readOnly: false,
      requiresApproval: true,
      reason: HIGH_RISK_TOOL_NAMES.has(toolName) ? "high_risk" : "unclassified",
    };
  }

  isReadOnlyTool(toolName: string) {
    return this.evaluateTool(toolName).readOnly;
  }

  requiresToolApproval(toolName: string) {
    return this.evaluateTool(toolName).requiresApproval;
  }

  approvalPolicyForAutonomy(autonomyLevel: number): ApprovalPolicy {
    if (
      !Number.isInteger(autonomyLevel) ||
      autonomyLevel < 0 ||
      autonomyLevel > 4
    )
      throw new RangeError("Autonomy level must be an integer from 0 to 4");
    return autonomyLevel === 4 ? "destructive_only" : "always";
  }

  approvalPolicyForMode(mode: AutonomyMode): ApprovalPolicy {
    return mode === "ask"
      ? "always"
      : mode === "off"
        ? "never"
        : "destructive_only";
  }

  resolveSnapshot(
    toolNames: readonly string[],
    approvalPolicy: ApprovalPolicy,
    capabilities: readonly PolicyCapability[] = [],
  ): ResolvedPolicySnapshot {
    const byKey = new Map(
      capabilities.map((capability) => [capability.key, capability]),
    );
    const resolvedCapabilities = Object.fromEntries(
      toolNames.map((toolName) => [
        toolName,
        byKey.get(toolName) ?? { id: `tool:${toolName}`, key: toolName },
      ]),
    );
    return {
      version: 2,
      approvalPolicy,
      authority: {
        capabilityIds: Object.values(resolvedCapabilities).map(({ id }) => id),
      },
      capabilities: resolvedCapabilities,
      tools: Object.fromEntries(
        toolNames.map((toolName) => [toolName, this.evaluateTool(toolName)]),
      ),
    };
  }
}

export const policyEngine = new PolicyEngine();
