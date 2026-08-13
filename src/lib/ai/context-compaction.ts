import "server-only";

import { LanguageModel, UIMessage, generateText } from "ai";
import { eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { ChatThreadContextTable } from "lib/db/pg/schema.pg";

const SAFETY_MARGIN = 0.85;

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

/** Keeps visible history intact and persists a rolling server-only conversation summary. */
export async function compactContext({
  threadId,
  messages,
  contextWindow,
  model,
}: {
  threadId: string;
  messages: UIMessage[];
  contextWindow: number;
  model: LanguageModel;
}) {
  const budget = Math.floor(contextWindow * SAFETY_MARGIN);
  if (estimateMessageTokens(messages) <= budget) return messages;

  let retained: UIMessage[] = [];
  for (const message of [...messages].reverse()) {
    if (estimateMessageTokens([message, ...retained]) > budget * 0.55) break;
    retained = [message, ...retained];
  }
  const oldMessages = messages.slice(
    0,
    Math.max(0, messages.length - retained.length),
  );
  const [previous] = await pgDb
    .select()
    .from(ChatThreadContextTable)
    .where(eq(ChatThreadContextTable.threadId, threadId))
    .limit(1);
  const source = oldMessages
    .map((message) => `${message.role}: ${textFromMessage(message)}`)
    .join("\n");
  const { text: summary } = await generateText({
    model,
    instructions:
      "Summarize this chat context factually and compactly. Preserve user goals, decisions, constraints, and unresolved questions. Do not mention that you are summarizing.",
    prompt: `${previous?.summary ? `Previous summary:\n${previous.summary}\n\n` : ""}Conversation to compact:\n${source.slice(0, 24_000)}`,
  });
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
  return [
    {
      id: `context-summary-${threadId}`,
      role: "system",
      parts: [{ type: "text", text: `Conversation summary:\n${summary}` }],
    } as UIMessage,
    ...retained,
  ];
}
