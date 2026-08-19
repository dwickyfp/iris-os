import type { UIMessage } from "ai";
import type {
  ContextPlanner,
  ContextPlannerInput,
  ContextPlan,
} from "../context-planner";

const SAFETY_MARGIN = 0.85;
const RETAINED_BUDGET_RATIO = 0.55;

export type ContextProvenance = {
  source: "conversation" | "conversation_summary";
  messageIds: string[];
};

export type ContextSourceKind =
  | "current_request"
  | "conversation"
  | "conversation_summary"
  | "agent"
  | "workspace"
  | "task"
  | "memory"
  | "skill"
  | "resource"
  | "mcp"
  | "user_preferences"
  | "remote_observation"
  | "continuation";

export type ContextTrust = "trusted" | "untrusted" | "mixed";

export type ContextSourceRecord = {
  id: string;
  kind: ContextSourceKind;
  priority: number;
  trust: ContextTrust;
  included: boolean;
  truncated: boolean;
  estimatedTokens: number;
};

export type ContextResolveSource = {
  id?: string;
  kind: ContextSourceKind;
  content: string;
  priority?: number;
  trust?: ContextTrust;
};

export type ResolvedContext = {
  instructions: string;
  messages: UIMessage[];
  sourceRecords: ContextSourceRecord[];
  estimatedTokens: number;
  truncatedSources: string[];
  trustBoundaries: string[];
  provenance: ContextProvenance[];
  diagnostics: ContextDiagnostics;
};

export type ContextDiagnostics = {
  compacted: boolean;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  budget: number;
  retainedMessages: number;
  summarizedMessages: number;
};

export type ContextCompactionResult = {
  messages: UIMessage[];
  provenance: ContextProvenance[];
  diagnostics: ContextDiagnostics;
};

export type ContextEngineDependencies = {
  planner: Pick<ContextPlanner, "plan">;
  loadSummary(threadId: string): Promise<string | undefined>;
  summarize(input: { instructions: string; prompt: string }): Promise<string>;
  saveSummary(threadId: string, summary: string): Promise<void>;
};

export function estimateMessageTokens(messages: UIMessage[]) {
  return Math.ceil(JSON.stringify(messages).length / 3.5);
}

function textFromMessage(message: UIMessage) {
  return message.parts
    .filter((part: any) => part.type === "text")
    .map((part: any) => part.text)
    .join(" ")
    .slice(0, 4_000);
}

export class ContextEngine {
  constructor(private readonly dependencies: ContextEngineDependencies) {}

  plan(input: ContextPlannerInput): ContextPlan {
    return this.dependencies.planner.plan(input);
  }

  /** Assemble every request source in one deterministic, auditable pass. */
  async resolve(input: {
    threadId?: string;
    currentRequest?: string;
    instructions?: string;
    sources?: ContextResolveSource[];
    messages?: UIMessage[];
    contextWindow?: number;
  }): Promise<ResolvedContext> {
    const sourceOrder: ContextResolveSource[] = [
      ...(input.currentRequest
        ? [{ kind: "current_request" as const, content: input.currentRequest }]
        : []),
      ...(input.sources ?? []),
    ];
    const budget = Math.floor((input.contextWindow ?? 12_000) * SAFETY_MARGIN);
    let remaining = budget;
    const records: ContextSourceRecord[] = [];
    const included: string[] = [];
    const truncatedSources: string[] = [];
    const ordered = sourceOrder
      .map((source, index) => ({
        ...source,
        id: source.id ?? `${source.kind}-${index}`,
        priority: source.priority ?? 100 - index,
        trust: source.trust ?? "untrusted",
      }))
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const instructionParts: string[] = [];
    for (const source of ordered) {
      const tokens = Math.max(1, Math.ceil(source.content.length / 4));
      const canInclude = source.kind === "current_request" || tokens <= remaining;
      const content = canInclude
        ? source.content
        : source.content.slice(0, Math.max(4, remaining * 4));
      const truncated = content.length < source.content.length;
      const used = Math.max(1, Math.ceil(content.length / 4));
      records.push({
        id: source.id,
        kind: source.kind,
        priority: source.priority,
        trust: source.trust,
        included: content.length > 0,
        truncated,
        estimatedTokens: content.length > 0 ? used : 0,
      });
      if (content) {
        included.push(source.id);
        instructionParts.push(content);
        remaining = Math.max(0, remaining - used);
      }
      if (truncated || (!canInclude && tokens > 0)) truncatedSources.push(source.id);
    }
    const conversation = input.messages ?? [];
    const compacted = input.threadId
      ? await this.compact({
          threadId: input.threadId,
          messages: conversation,
          contextWindow: Math.max(1, remaining * 4),
        })
      : {
          messages: conversation,
          provenance: [{ source: "conversation" as const, messageIds: conversation.map((m) => m.id) }],
          diagnostics: {
            compacted: false,
            estimatedTokensBefore: estimateMessageTokens(conversation),
            estimatedTokensAfter: estimateMessageTokens(conversation),
            budget,
            retainedMessages: conversation.length,
            summarizedMessages: 0,
          },
        };
    for (const provenance of compacted.provenance) {
      records.push({
        id: provenance.source,
        kind: provenance.source,
        priority: 0,
        trust: "untrusted",
        included: true,
        truncated: provenance.source === "conversation_summary",
        estimatedTokens: 0,
      });
    }
    const trustBoundaries = records
      .filter((record) => record.trust !== "trusted")
      .map((record) => `${record.id}:${record.trust}`);
    return {
      instructions: [input.instructions, ...instructionParts].filter(Boolean).join("\n\n"),
      messages: compacted.messages,
      sourceRecords: records,
      estimatedTokens: records.reduce((sum, record) => sum + record.estimatedTokens, 0),
      truncatedSources: [...new Set(truncatedSources)],
      trustBoundaries,
      provenance: compacted.provenance,
      diagnostics: compacted.diagnostics,
    };
  }

  async compact(input: {
    threadId: string;
    messages: UIMessage[];
    contextWindow: number;
  }): Promise<ContextCompactionResult> {
    const { threadId, messages, contextWindow } = input;
    const budget = Math.floor(contextWindow * SAFETY_MARGIN);
    const estimatedTokensBefore = estimateMessageTokens(messages);

    if (estimatedTokensBefore <= budget) {
      return {
        messages,
        provenance: [
          {
            source: "conversation",
            messageIds: messages.map((message) => message.id),
          },
        ],
        diagnostics: {
          compacted: false,
          estimatedTokensBefore,
          estimatedTokensAfter: estimatedTokensBefore,
          budget,
          retainedMessages: messages.length,
          summarizedMessages: 0,
        },
      };
    }

    let retained: UIMessage[] = [];
    for (const message of [...messages].reverse()) {
      if (
        estimateMessageTokens([message, ...retained]) >
        budget * RETAINED_BUDGET_RATIO
      ) {
        break;
      }
      retained = [message, ...retained];
    }
    const oldMessages = messages.slice(
      0,
      Math.max(0, messages.length - retained.length),
    );
    const previousSummary = await this.dependencies.loadSummary(threadId);
    const source = oldMessages
      .map((message) => `${message.role}: ${textFromMessage(message)}`)
      .join("\n");
    const summary = await this.dependencies.summarize({
      instructions:
        "Summarize this chat context factually and compactly. Preserve user goals, decisions, constraints, and unresolved questions. Do not mention that you are summarizing.",
      prompt: `${previousSummary ? `Previous summary:\n${previousSummary}\n\n` : ""}Conversation to compact:\n${source.slice(0, 24_000)}`,
    });
    await this.dependencies.saveSummary(threadId, summary);

    const summaryMessage = {
      id: `context-summary-${threadId}`,
      role: "system",
      parts: [{ type: "text", text: `Conversation summary:\n${summary}` }],
    } as UIMessage;
    const compactedMessages = [summaryMessage, ...retained];

    return {
      messages: compactedMessages,
      provenance: [
        {
          source: "conversation_summary",
          messageIds: oldMessages.map((message) => message.id),
        },
        {
          source: "conversation",
          messageIds: retained.map((message) => message.id),
        },
      ],
      diagnostics: {
        compacted: true,
        estimatedTokensBefore,
        estimatedTokensAfter: estimateMessageTokens(compactedMessages),
        budget,
        retainedMessages: retained.length,
        summarizedMessages: oldMessages.length,
      },
    };
  }
}
