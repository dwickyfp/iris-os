export type ContextSource =
  | "current_request"
  | "task"
  | "workspace_instructions"
  | "agent_and_skills"
  | "memory"
  | "resources"
  | "conversation";

export type ContextPlannerInput = {
  currentRequest: string;
  task?: string;
  workspaceInstructions?: string;
  agentAndSkills?: string;
  memories?: string;
  resources?: string;
  conversation?: string;
};

export type ContextSection = {
  source: ContextSource;
  content: string;
  trusted: boolean;
  estimatedTokens: number;
};

export type ContextPlan = {
  sections: ContextSection[];
  truncated: ContextSource[];
  estimatedTokens: number;
};

const order: Array<keyof ContextPlannerInput> = [
  "currentRequest",
  "task",
  "workspaceInstructions",
  "agentAndSkills",
  "memories",
  "resources",
  "conversation",
];

const names: Record<keyof ContextPlannerInput, ContextSource> = {
  currentRequest: "current_request",
  task: "task",
  workspaceInstructions: "workspace_instructions",
  agentAndSkills: "agent_and_skills",
  memories: "memory",
  resources: "resources",
  conversation: "conversation",
};

export class ContextPlanner {
  constructor(private readonly tokenBudget = 12_000) {}

  plan(input: ContextPlannerInput): ContextPlan {
    let remaining = this.tokenBudget;
    const sections: ContextSection[] = [];
    const truncated: ContextSource[] = [];
    for (const key of order) {
      const content = input[key]?.trim();
      if (!content) continue;
      const estimatedTokens = Math.max(1, Math.ceil(content.length / 4));
      if (estimatedTokens > remaining && key !== "currentRequest") {
        truncated.push(names[key]);
        continue;
      }
      const bounded =
        estimatedTokens > remaining
          ? content.slice(0, Math.max(4, remaining * 4))
          : content;
      const used = Math.max(1, Math.ceil(bounded.length / 4));
      sections.push({
        source: names[key],
        content: bounded,
        trusted: key === "workspaceInstructions",
        estimatedTokens: used,
      });
      remaining = Math.max(0, remaining - used);
    }
    return {
      sections,
      truncated,
      estimatedTokens: this.tokenBudget - remaining,
    };
  }
}
