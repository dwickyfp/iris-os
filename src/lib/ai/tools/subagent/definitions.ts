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

export type SubagentActivity = {
  /** Completed + in-flight subagent steps. */
  steps: number;
  /** Tool names the subagent has invoked so far, in order. */
  tools: string[];
  /** Latest assistant text produced by the subagent. */
  text: string;
};

/** Summarize what a subagent is doing from its streamed UIMessage. */
export function extractSubagentActivity(message: UIMessage): SubagentActivity {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const tools: string[] = [];
  let steps = 0;
  for (const part of parts) {
    if (part.type === "step-start") {
      steps += 1;
      continue;
    }
    if (typeof part.type === "string" && part.type.startsWith("tool-")) {
      const name = (part as { toolName?: string }).toolName;
      if (name) tools.push(name);
    }
  }
  return { steps, tools, text: extractSubagentProgressText(message) };
}

export type SubagentTimelineItem =
  | { kind: "tool"; name: string; done: boolean }
  | { kind: "text"; text: string }
  | { kind: "reasoning" };

/**
 * Ordered trace of what the subagent has done so far, built from the
 * accumulated UIMessage streamed as preliminary tool output.
 */
export function extractSubagentTimeline(message: UIMessage): {
  steps: number;
  items: SubagentTimelineItem[];
  text: string;
} {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const items: SubagentTimelineItem[] = [];
  let steps = 0;
  let text = "";
  for (const part of parts) {
    if (part.type === "step-start") {
      steps += 1;
      continue;
    }
    if (typeof part.type === "string" && part.type.startsWith("tool-")) {
      const typed = part as { toolName?: string; state?: string };
      if (typed.toolName) {
        items.push({
          kind: "tool",
          name: typed.toolName,
          done:
            typed.state === "output-available" ||
            typed.state === "output-error",
        });
      }
      continue;
    }
    if (part.type === "reasoning") continue;
    if (part.type === "text") {
      text = part.text;
      items.push({ kind: "text", text: part.text });
    }
  }
  return { steps, items, text };
}

/**
 * Client-side wall-clock start times per spawn_subagent tool call. The card
 * records it on first render so the artifact panel can show elapsed time even
 * before the subagent finishes.
 */
export const subagentStartTimes = new Map<string, number>();

export function recordSubagentStart(toolCallId: string) {
  if (!subagentStartTimes.has(toolCallId)) {
    subagentStartTimes.set(toolCallId, Date.now());
  }
  return subagentStartTimes.get(toolCallId)!;
}

export type SubagentPanelDescriptor = {
  toolCallId: string;
  subagent: SubagentType;
  title: string;
  task: string;
};

/**
 * Normalizes the persisted panel descriptor. Older releases stored a bare
 * toolCallId string here; anything unrecognized becomes undefined so a stale
 * value can never silently suppress the panel.
 */
export function normalizeSubagentPanel(
  value: unknown,
): SubagentPanelDescriptor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<SubagentPanelDescriptor>;
  if (typeof candidate.toolCallId !== "string" || !candidate.toolCallId) {
    return undefined;
  }
  return {
    toolCallId: candidate.toolCallId,
    subagent:
      candidate.subagent && candidate.subagent in SUBAGENT_SPECS
        ? candidate.subagent
        : "general",
    title: typeof candidate.title === "string" ? candidate.title : "",
    task: typeof candidate.task === "string" ? candidate.task : "",
  };
}

/**
 * In-memory report cache keyed by tool call id. Reports are deliberately kept
 * out of the persisted store (large Markdown would risk the localStorage
 * quota and could drop unrelated state on write).
 */
export const subagentReports = new Map<string, SpawnSubagentOutput>();

export function rememberSubagentReport(
  toolCallId: string,
  output: SpawnSubagentOutput,
) {
  subagentReports.set(toolCallId, output);
}

export function subagentReport(
  toolCallId: string | undefined,
): SpawnSubagentOutput | undefined {
  return toolCallId ? subagentReports.get(toolCallId) : undefined;
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
