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
