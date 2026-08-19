import { DefaultToolName, ImageToolName } from "lib/ai/tools";
import { SKILLS_LIST_TOOL_NAME, SKILL_VIEW_TOOL_NAME } from "../skill";
import { MANAGE_LEARNING_TOOL_NAME } from "../tools/background/names";
import type { ApprovalPolicy } from "../agent/runtime-context";
import type { ResolvedPolicySnapshot } from "./contracts";

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

export type PolicyDecision = {
  toolName: string;
  readOnly: boolean;
  requiresApproval: boolean;
  reason: "explicit_low_risk" | "read_only" | "high_risk" | "unclassified";
};

export type AutonomyMode = "standard" | "ask" | "off";

export class PolicyEngine {
  evaluateTool(toolName: string): PolicyDecision {
    if (EXPLICIT_LOW_RISK_TOOL_NAMES.has(toolName)) {
      return {
        toolName,
        readOnly: false,
        requiresApproval: false,
        reason: "explicit_low_risk",
      };
    }
    if (READ_ONLY_TOOL_NAMES.has(toolName)) {
      return {
        toolName,
        readOnly: true,
        requiresApproval: false,
        reason: "read_only",
      };
    }
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
    ) {
      throw new RangeError("Autonomy level must be an integer from 0 to 4");
    }
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
  ): ResolvedPolicySnapshot {
    return {
      approvalPolicy,
      tools: Object.fromEntries(
        toolNames.map((toolName) => [toolName, this.evaluateTool(toolName)]),
      ),
    };
  }
}

export const policyEngine = new PolicyEngine();
