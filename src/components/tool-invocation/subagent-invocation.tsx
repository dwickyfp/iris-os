"use client";

import { appStore } from "@/app/store";
import { ToolUIPart } from "ai";
import {
  FileTextIcon,
  LoaderIcon,
  PanelRightOpenIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useCallback, useMemo } from "react";
import { Badge } from "ui/badge";
import { TextShimmer } from "ui/text-shimmer";
import { cn, truncateString } from "lib/utils";
import {
  SUBAGENT_SPECS,
  type SubagentType,
  extractSubagentProgressText,
  isSpawnSubagentOutput,
} from "lib/ai/tools/subagent/definitions";

const SUBAGENT_ICONS: Record<SubagentType, typeof SearchIcon> = {
  research: SearchIcon,
  audit: ShieldCheckIcon,
  general: SparklesIcon,
};

interface SubagentInvocationProps {
  part: ToolUIPart;
  threadId?: string;
}

function PureSubagentInvocation({ part, threadId }: SubagentInvocationProps) {
  const t = useTranslations();
  const state = part.state;
  const input = (part.input ?? {}) as {
    subagent?: SubagentType;
    title?: string;
    task?: string;
  };
  const subagentType =
    input.subagent && input.subagent in SUBAGENT_SPECS
      ? input.subagent
      : "general";
  const spec = SUBAGENT_SPECS[subagentType];
  const Icon = SUBAGENT_ICONS[subagentType];

  const isRunning = state === "input-streaming" || state === "input-available";
  const output = state === "output-available" ? part.output : undefined;
  const result = isSpawnSubagentOutput(output) ? output : undefined;
  // While streaming, output is the accumulated UIMessage of the subagent so far.
  const progressText =
    !result && output && typeof output === "object" && "parts" in output
      ? extractSubagentProgressText(output as never)
      : "";

  const openPanel = useCallback(() => {
    if (!threadId) return;
    appStore.getState().mutate((prev) => ({
      subagentArtifactPanels: {
        ...prev.subagentArtifactPanels,
        [threadId]: part.toolCallId,
      },
    }));
  }, [threadId, part.toolCallId]);

  const statusLabel = useMemo(() => {
    if (isRunning) return t("Chat.Tool.subagentWorking");
    if (state === "output-error") return t("Chat.Tool.subagentFailed");
    return t("Chat.Tool.subagentCompleted");
  }, [isRunning, state, t]);

  const canOpen = Boolean(threadId) && state === "output-available";

  return (
    <div
      data-testid="subagent-invocation"
      className={cn(
        "flex flex-col gap-2 w-full rounded-lg border bg-card p-4 text-sm transition-colors",
        canOpen && "cursor-pointer hover:border-primary/50",
      )}
      onClick={canOpen ? openPanel : undefined}
      role={canOpen ? "button" : undefined}
      title={canOpen ? t("Chat.Tool.subagentOpenArtifact") : undefined}
    >
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            "size-4 shrink-0",
            isRunning ? "wiggle text-primary" : "text-muted-foreground",
          )}
        />
        <Badge variant="outline" className="shrink-0">
          {spec.label}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-medium">
          {input.title || t("Chat.Tool.subagentDefaultTitle")}
        </span>
        {isRunning && <LoaderIcon className="size-4 shrink-0 animate-spin" />}
        {result?.artifact && (
          <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        {result?.durationMs != null && (
          <Badge variant="secondary" className="shrink-0">
            {Math.round(result.durationMs / 100) / 10}s
          </Badge>
        )}
        {canOpen && (
          <PanelRightOpenIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
      </div>
      {isRunning ? (
        <div className="flex flex-col gap-1">
          <TextShimmer>{statusLabel}</TextShimmer>
          {progressText && (
            <p className="text-xs text-muted-foreground line-clamp-3 whitespace-pre-wrap">
              {truncateString(progressText, 240)}
            </p>
          )}
        </div>
      ) : state === "output-error" ? (
        <p className="text-xs text-destructive">{statusLabel}</p>
      ) : result ? (
        <p className="text-xs text-muted-foreground line-clamp-2 whitespace-pre-wrap">
          {truncateString(result.report, 200) ||
            t("Chat.Tool.subagentEmptyReport")}
        </p>
      ) : null}
    </div>
  );
}

export const SubagentInvocation = memo(PureSubagentInvocation);
