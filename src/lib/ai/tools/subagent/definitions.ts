import { type Tool, UIMessage } from "ai";
import { z } from "zod";
import { DefaultToolName } from "..";

export const SUBAGENT_TYPES = ["research", "audit", "general"] as const;
export type SubagentType = (typeof SUBAGENT_TYPES)[number];

export type SubagentSpec = {
  type: SubagentType;
  label: string;
  description: string;
  instructions: string;
};

export const SUBAGENT_SPECS: Record<SubagentType, SubagentSpec> = {
  research: {
    type: "research",
    label: "Research",
    description: "Deep research with web search and a sourced report.",
    instructions: `You are a research subagent. Complete the research task autonomously using the tools available to you.

Rules:
- Investigate the task thoroughly; use search/content tools when available.
- Ground every factual claim in what you actually retrieved; never fabricate sources.
- Keep the main agent's context small: you explore broadly, report concisely.

IMPORTANT: When you have finished, write a clear Markdown report as your final response. This report is returned to the main agent and stored as an artifact, so include all relevant information: a short executive summary, key findings, and a "## Sources" section listing the URLs or references you used.`,
  },
  audit: {
    type: "audit",
    label: "Audit",
    description: "Critical review of claims, content, or decisions.",
    instructions: `You are an audit subagent. You critically review the subject of the task (claims, content, a plan, a decision, or provided material) and report problems.

Rules:
- Check claims against the material and available tools; be skeptical and precise.
- Classify each finding by severity (critical / major / minor) with concrete evidence.
- Do not fix anything; your job is an honest, evidence-backed assessment.

IMPORTANT: When you have finished, write a clear Markdown report as your final response. This report is returned to the main agent and stored as an artifact, so include: a short verdict, findings with severity and evidence, and open questions.`,
  },
  general: {
    type: "general",
    label: "General",
    description: "Autonomous task execution with a summarized result.",
    instructions: `You are a subagent. Complete the given task autonomously with the tools available to you.

IMPORTANT: When you have finished, write a clear summary of your findings and outcome as your final Markdown response. This summary is returned to the main agent and stored as an artifact, so include all relevant information the main agent needs.`,
  },
};

export const subagentInputSchema = z.object({
  subagent: z
    .enum(SUBAGENT_TYPES)
    .describe("The kind of subagent to spawn for this task."),
  title: z
    .string()
    .min(1)
    .max(120)
    .describe("Short human-readable title for the resulting artifact."),
  task: z
    .string()
    .min(1)
    .describe(
      "Complete, self-contained task for the subagent. It cannot see this conversation, so include all needed context.",
    ),
});

export type SpawnSubagentInput = z.infer<typeof subagentInputSchema>;

export type SpawnSubagentArtifact = {
  artifactId: string;
  filename: string;
  mediaType: string;
  size: number;
};

export type SpawnSubagentOutput = {
  status: "completed";
  subagent: SubagentType;
  task: string;
  title: string;
  /** Final Markdown report produced by the subagent. */
  report: string;
  /** Canonical artifact reference, null when artifact storage failed. */
  artifact: SpawnSubagentArtifact | null;
  steps: number;
  durationMs: number;
};

/** Narrow a tool part output into the final structured result. */
export function isSpawnSubagentOutput(
  output: unknown,
): output is SpawnSubagentOutput {
  return (
    typeof output === "object" &&
    output !== null &&
    (output as { status?: unknown }).status === "completed" &&
    typeof (output as { report?: unknown }).report === "string"
  );
}

/** Extract the latest text from a streamed subagent UIMessage. */
export function extractSubagentProgressText(message: UIMessage): string {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const lastText = [...parts].reverse().find((part) => part.type === "text");
  return lastText && "text" in lastText ? lastText.text : "";
}

/**
 * Tools a subagent may use: the intersection of the parent's tools with a
 * read-only allowlist (subagents cannot use approval flows, so nothing
 * side-effecting is ever delegated).
 */
export const SUBAGENT_TOOL_ALLOWLIST = [
  DefaultToolName.WebSearch,
  DefaultToolName.WebContent,
] as const;

export function selectSubagentTools(
  parentTools: Record<string, Tool>,
): Record<string, Tool> {
  return Object.fromEntries(
    SUBAGENT_TOOL_ALLOWLIST.filter((name) => name in parentTools).map(
      (name) => [name, parentTools[name]],
    ),
  );
}
