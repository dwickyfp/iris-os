import type { UIMessage } from "ai";
import type { ContextEngine, ResolvedContext } from "./context-engine";

export type RunPreparationInput = {
  request?: string;
  instructions?: string;
  messages?: UIMessage[];
  threadId?: string;
  contextWindow?: number;
  sources?: Parameters<ContextEngine["resolve"]>[0]["sources"];
};

export type PreparedRun = {
  context: ResolvedContext;
  messages: UIMessage[];
  instructions: string;
};

/** Shared context/budget preparation for foreground, automation, and resume runs. */
export class RunPreparer {
  constructor(private readonly contextEngine: Pick<ContextEngine, "resolve">) {}

  async prepare(input: RunPreparationInput): Promise<PreparedRun> {
    const context = await this.contextEngine.resolve({
      currentRequest: input.request,
      instructions: input.instructions,
      messages: input.messages,
      threadId: input.threadId,
      contextWindow: input.contextWindow,
      sources: input.sources,
    });
    return {
      context,
      messages: context.messages,
      instructions: context.instructions,
    };
  }
}
