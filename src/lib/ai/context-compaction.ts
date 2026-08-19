import "server-only";

import { UIMessage, generateText } from "ai";
import { eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { ChatThreadContextTable } from "lib/db/pg/schema.pg";
import { customModelProvider } from "lib/ai/models";
import { ContextPlanner } from "./context-planner";
import { ContextEngine, estimateMessageTokens } from "./runtime/context-engine";

export { estimateMessageTokens };

export const contextEngine = new ContextEngine({
  planner: new ContextPlanner(),
  async loadSummary(threadId) {
    const [previous] = await pgDb
      .select()
      .from(ChatThreadContextTable)
      .where(eq(ChatThreadContextTable.threadId, threadId))
      .limit(1);
    return previous?.summary;
  },
  async summarize(input) {
    const { text } = await generateText({
      model: await customModelProvider.getEngineModel("context-summary"),
      ...input,
    });
    return text;
  },
  async saveSummary(threadId, summary) {
    await pgDb
      .insert(ChatThreadContextTable)
      .values({
        threadId,
        summary,
        summarizedUntil: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: ChatThreadContextTable.threadId,
        set: { summary, summarizedUntil: new Date(), updatedAt: new Date() },
      });
  },
});

/** Keeps visible history intact and persists a rolling server-only conversation summary. */
export async function compactContext({
  threadId,
  messages,
  contextWindow,
}: {
  threadId: string;
  messages: UIMessage[];
  contextWindow: number;
}) {
  const result = await prepareContext({ threadId, messages, contextWindow });
  return result.messages;
}

export async function prepareContext({
  threadId,
  messages,
  contextWindow,
}: {
  threadId: string;
  messages: UIMessage[];
  contextWindow: number;
}) {
  return contextEngine.compact({
    threadId,
    messages,
    contextWindow,
  });
}
