"use client";

import { appStore } from "@/app/store";
import { usePathname } from "next/navigation";
import { useShallow } from "zustand/shallow";
import { ChatSession } from "./chat-bot";

/**
 * Keeps every opened chat mounted below the shared chat layout. A hidden session
 * continues receiving its response while the user opens or visits another chat.
 */
export function ChatSessionHost() {
  const pathname = usePathname();
  const [chatSessions, activeChatSessionId] = appStore(
    useShallow((state) => [state.chatSessions, state.activeChatSessionId]),
  );
  const isChatRoute = pathname === "/" || pathname.startsWith("/chat/");

  return Object.entries(chatSessions).map(([threadId, session]) => {
    const isActive = activeChatSessionId === threadId;
    const isVisible = isChatRoute && isActive;

    return (
      <div
        key={threadId}
        className={isVisible ? "h-full" : "hidden"}
        aria-hidden={!isVisible}
      >
        <ChatSession
          threadId={threadId}
          initialMessages={session.initialMessages}
          isActive={isActive}
        />
      </div>
    );
  });
}
