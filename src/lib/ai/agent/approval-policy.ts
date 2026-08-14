import { DefaultToolName, ImageToolName } from "lib/ai/tools";
import { SKILLS_LIST_TOOL_NAME, SKILL_VIEW_TOOL_NAME } from "../skill";
import { MANAGE_LEARNING_TOOL_NAME } from "../tools/background/names";

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

export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(toolName);
}

export function requiresToolApproval(toolName: string): boolean {
  if (EXPLICIT_LOW_RISK_TOOL_NAMES.has(toolName)) return false;
  if (isReadOnlyTool(toolName)) return false;
  if (HIGH_RISK_TOOL_NAMES.has(toolName)) return true;
  // Workflow and all MCP tools are fail-safe by default.
  return true;
}
