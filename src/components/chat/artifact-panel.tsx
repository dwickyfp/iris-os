"use client";

import { appStore } from "@/app/store";
import { isToolUIPart, type UIMessage } from "ai";
import { AnimatePresence, motion } from "framer-motion";
import { DownloadIcon, FileTextIcon, LoaderIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { TextShimmer } from "ui/text-shimmer";
import { truncateString } from "lib/utils";
import {
  SUBAGENT_SPECS,
  type SubagentPanelDescriptor,
  isSpawnSubagentOutput,
  recordSubagentStart,
  subagentReport,
} from "lib/ai/tools/subagent/definitions";
import { PreviewMessage } from "../message";

export function isSubagentUIMessage(output: unknown): output is UIMessage {
  return (
    typeof output === "object" &&
    output !== null &&
    "parts" in output &&
    Array.isArray((output as { parts?: unknown }).parts)
  );
}

const PANEL_WIDTH = 400;

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Ticking wall-clock duration while the subagent is still running. */
function useElapsed(startedAt: number | undefined, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return startedAt ? formatElapsed(Math.max(0, now - startedAt)) : undefined;
}

function RunningHeader({ startedAt }: { startedAt: number }) {
  const t = useTranslations();
  const elapsed = useElapsed(startedAt, true);
  return (
    <div className="mx-4 mb-2 flex items-center gap-2 text-muted-foreground">
      <LoaderIcon className="size-4 animate-spin" />
      {elapsed ? (
        <TextShimmer>
          {t("Chat.Tool.subagentElapsed", { time: elapsed })}
        </TextShimmer>
      ) : (
        <TextShimmer>{t("Chat.Tool.subagentWorking")}</TextShimmer>
      )}
    </div>
  );
}

interface ArtifactPanelProps {
  threadId: string;
  messages: UIMessage[];
}

function PanelContent({
  threadId,
  messages,
  descriptor,
}: {
  threadId: string;
  messages: UIMessage[];
  descriptor: SubagentPanelDescriptor;
}) {
  const t = useTranslations();
  const toolCallId = descriptor.toolCallId;

  const livePart = (() => {
    for (const message of messages) {
      for (const candidate of message.parts) {
        if (isToolUIPart(candidate) && candidate.toolCallId === toolCallId) {
          return candidate;
        }
      }
    }
    return null;
  })();
  // Freeze the last part ever seen so a transient message rebuild cannot blank
  // the live view; the in-memory report cache is the second fallback.
  const frozen = useRef<typeof livePart>(null);
  if (livePart) frozen.current = livePart;
  const part = livePart ?? frozen.current;

  const hasOutput = part?.state === "output-available";
  const live =
    hasOutput &&
    part?.output &&
    !isSpawnSubagentOutput(part.output) &&
    isSubagentUIMessage(part.output)
      ? part.output
      : undefined;
  const resultOut =
    hasOutput && part?.output && isSpawnSubagentOutput(part.output)
      ? part.output
      : undefined;
  const result = resultOut ?? subagentReport(toolCallId);

  const subagent =
    descriptor.subagent in SUBAGENT_SPECS ? descriptor.subagent : "general";
  const spec = SUBAGENT_SPECS[subagent];
  const title =
    result?.title || descriptor.title || t("Chat.Tool.subagentDefaultTitle");
  const finished = Boolean(result?.report);
  const artifact = result?.artifact;

  const close = () =>
    appStore.getState().mutate((prev) => ({
      subagentArtifactPanels: {
        ...prev.subagentArtifactPanels,
        [threadId]: undefined,
      },
    }));

  // Never hand an empty message to the renderer: PreviewMessage returns null
  // for a part-less message, which would leave the panel blank.
  const displayMessage: UIMessage =
    live ??
    (result?.report
      ? {
          id: `subagent-report-${toolCallId}`,
          role: "assistant",
          parts: [{ type: "text", text: result.report }],
        }
      : {
          id: `subagent-pending-${toolCallId}`,
          role: "assistant",
          parts: [{ type: "text", text: t("Chat.Tool.subagentPanelPending") }],
        });

  return (
    <div className="flex h-full w-[400px] flex-col">
      <header className="flex items-center gap-2 border-b p-4">
        <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {truncateString(title, 60)}
          </p>
          <p className="text-xs text-muted-foreground">
            {spec.label}
            {artifact ? ` · ${artifact.filename}` : ""}
          </p>
        </div>
        {artifact && (
          <Button asChild size="icon" variant="ghost" aria-label="Download">
            <a
              href={`/api/artifacts/${artifact.artifactId}`}
              download={artifact.filename}
            >
              <DownloadIcon className="size-4" />
            </a>
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("Chat.Tool.subagentClosePanel")}
          onClick={close}
        >
          <XIcon className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto py-3 text-sm">
        {descriptor.task && (
          <div className="mx-4 mb-3 rounded-lg border bg-muted/40 p-3 text-xs whitespace-pre-wrap text-muted-foreground">
            {truncateString(descriptor.task, 400)}
          </div>
        )}
        {finished ? (
          <div className="mx-4 mb-2 flex items-center gap-2">
            <Badge variant="secondary">
              {t("Chat.Tool.subagentCompleted")}
            </Badge>
            {result?.durationMs != null && (
              <span className="text-xs text-muted-foreground">
                {formatElapsed(result.durationMs)}
              </span>
            )}
            {artifact && (
              <Badge variant="outline" className="ml-auto">
                {t("Chat.Tool.subagentArtifactBadge")}
              </Badge>
            )}
          </div>
        ) : (
          <RunningHeader startedAt={recordSubagentStart(toolCallId)} />
        )}
        <PreviewMessage
          threadId={threadId}
          message={displayMessage}
          readonly
          isLoading={!finished}
        />
      </div>
    </div>
  );
}

/**
 * Right-side artifact panel, rendered as a flex sibling of the chat column so
 * it simply occupies layout space. Previous portal/measurement approaches
 * depended on DOM measurement and z-index stacking, which made the panel
 * fragile; a layout sibling cannot be hidden by either.
 */
export function ArtifactPanel({ threadId, messages }: ArtifactPanelProps) {
  const descriptor = appStore(
    (state) => state.subagentArtifactPanels[threadId],
  ) as SubagentPanelDescriptor | undefined;

  return (
    <AnimatePresence initial={false}>
      {descriptor && (
        <motion.aside
          key="subagent-artifact-panel"
          data-testid="subagent-artifact-panel"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: PANEL_WIDTH, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ type: "spring", stiffness: 320, damping: 32 }}
          // ml-3 keeps the chat column's scrollbar from touching the card; the
          // margin only exists while the panel is mounted.
          className="relative my-3 mr-3 ml-4 shrink-0 self-stretch overflow-hidden rounded-xl border bg-background shadow-lg"
        >
          <PanelContent
            threadId={threadId}
            messages={messages}
            descriptor={descriptor}
          />
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
