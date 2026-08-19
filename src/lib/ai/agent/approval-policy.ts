import { policyEngine } from "../runtime/policy-engine";

export function isReadOnlyTool(toolName: string): boolean {
  return policyEngine.isReadOnlyTool(toolName);
}

export function requiresToolApproval(toolName: string): boolean {
  return policyEngine.requiresToolApproval(toolName);
}
