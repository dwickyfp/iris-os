"use client";

import { appStore } from "@/app/store";
import { isToolUIPart, type UIMessage } from "ai";
import { DownloadIcon, FileTextIcon, LoaderIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useMemo } from "react";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { cn, truncateString } from "lib/utils";
import {
  SUBAGENT_SPECS,
  type SubagentType,
  isSpawnSubagentOutput,
} from "lib/ai/tools/subagent/definitions";
import { Markdown } from "../markdown";

interface ArtifactPanelProps {
  threadId: string;
  messages: UIMessage[];
}

function PureArtifactPanel({ threadId, messages }: ArtifactPanelProps) {
  const t = useTranslations();
  const toolCallId = appStore(
    (state) => state.subagentArtifactPanels[threadId],
  );

  const part = useMemo(() => {
    if (!toolCallId) return null;
    for (const message of messages) {
      for (const candidate of message.parts) {
        if (isToolUIPart(candidate) && candidate.toolCallId === toolCallId) {
          return candidate;
        }
      }
    }
    return null;
  }, [messages, toolCallId]);

  if (!toolCallId || !part) return null;

  const input = (part.input ?? {}) as {
    subagent?: SubagentType;
    title?: string;
  };
  const spec =
    input.subagent && input.subagent in SUBAGENT_SPECS
      ? SUBAGENT_SPECS[input.subagent]
      : SUBAGENT_SPECS.general;
  const result =
    part.state === "output-available" && isSpawnSubagentOutput(part.output)
      ? part.output
      : undefined;
  const isRunning = !result;
  const artifact = result?.artifact;
  const title =
    result?.title || input.title || t("Chat.Tool.subagentDefaultTitle");

  const close = () => {
    appStore.getState().mutate((prev) => ({
      subagentArtifactPanels: {
        ...prev.subagentArtifactPanels,
        [threadId]: undefined,
      },
    }));
  };

  return (
    <aside
      data-testid="subagent-artifact-panel"
      className="relative flex h-full w-[380px] shrink-0 flex-col border-l bg-background md:w-[440px]"
    >
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
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto px-4 py-2 text-sm",
          isRunning && "flex items-center justify-center",
        )}
      >
        {isRunning ? (
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <LoaderIcon className="size-5 animate-spin" />
            <p className="text-xs">{t("Chat.Tool.subagentPanelPending")}</p>
          </div>
        ) : (
          <>
            {artifact && (
              <Badge variant="secondary" className="mb-2">
                {t("Chat.Tool.subagentArtifactBadge")}
              </Badge>
            )}
            <Markdown>{result!.report}</Markdown>
          </>
        )}
      </div>
    </aside>
  );
}

export const ArtifactPanel = memo(PureArtifactPanel);
