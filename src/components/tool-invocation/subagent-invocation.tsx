"use client";

import { appStore } from "@/app/store";
import { ToolUIPart, UIMessage } from "ai";
import {
  FileTextIcon,
  LoaderIcon,
  PanelRightOpenIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useCallback, useEffect, useMemo } from "react";
import { Badge } from "ui/badge";
import { TextShimmer } from "ui/text-shimmer";
import { cn, truncateString } from "lib/utils";
import {
  SUBAGENT_SPECS,
  type SubagentActivity,
  type SubagentType,
  extractSubagentActivity,
  isSpawnSubagentOutput,
  recordSubagentStart,
  rememberSubagentReport,
} from "lib/ai/tools/subagent/definitions";

const SUBAGENT_ICONS: Record<SubagentType, typeof SearchIcon> = {
  research: SearchIcon,
  audit: ShieldCheckIcon,
  general: SparklesIcon,
};

export function isSubagentUIMessage(output: unknown): output is UIMessage {
  return (
    typeof output === "object" &&
    output !== null &&
    "parts" in output &&
    Array.isArray((output as { parts?: unknown }).parts)
  );
}

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

  useEffect(() => {
    recordSubagentStart(part.toolCallId);
  }, [part.toolCallId]);

  // The subagent streams its accumulated UIMessage as preliminary tool
  // outputs before the final structured result; don't rely on the
  // preliminary flag alone — classify by output shape.
  const hasOutput = state === "output-available";
  const result =
    hasOutput && isSpawnSubagentOutput(part.output) ? part.output : undefined;
  const live =
    hasOutput && !result && isSubagentUIMessage(part.output)
      ? part.output
      : undefined;
  const isRunning =
    state === "input-streaming" || state === "input-available" || !!live;
  const activity: SubagentActivity | undefined = live
    ? extractSubagentActivity(live)
    : undefined;

  // Cache the finished report in memory: the panel reads it as a fallback if
  // the message part is temporarily unresolvable, without persisting large
  // Markdown into localStorage.
  useEffect(() => {
    if (result) rememberSubagentReport(part.toolCallId, result);
  }, [result, part.toolCallId]);

  const openPanel = useCallback(() => {
    if (!threadId) return;
    const current = appStore.getState().subagentArtifactPanels[threadId];
    appStore.getState().mutate((prev) => ({
      subagentArtifactPanels: {
        ...prev.subagentArtifactPanels,
        // Toggle: clicking the same card while its panel is open closes it.
        [threadId]:
          current?.toolCallId === part.toolCallId
            ? undefined
            : {
                toolCallId: part.toolCallId,
                subagent: subagentType,
                title: input.title || t("Chat.Tool.subagentDefaultTitle"),
                task: input.task ?? "",
              },
      },
    }));
  }, [threadId, part.toolCallId, subagentType, input.title, input.task, t]);

  const statusLabel = useMemo(() => {
    if (isRunning) return t("Chat.Tool.subagentWorking");
    if (state === "output-error") return t("Chat.Tool.subagentFailed");
    return t("Chat.Tool.subagentCompleted");
  }, [isRunning, state, t]);

  // Clickable as soon as there is anything to show: live progress while the
  // subagent runs, the report artifact once it completes.
  const canOpen = Boolean(threadId) && (hasOutput || isRunning);

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
          {activity && (activity.steps > 0 || activity.tools.length > 0) && (
            <p className="text-xs text-muted-foreground">
              {activity.steps > 0 && (
                <span>
                  {t("Chat.Tool.subagentStepCount", { count: activity.steps })}
                </span>
              )}
              {activity.tools.length > 0 && (
                <span>
                  {activity.steps > 0 ? " · " : ""}
                  {truncateString([...new Set(activity.tools)].join(", "), 40)}
                </span>
              )}
            </p>
          )}
          {activity?.text && (
            <p className="text-xs text-muted-foreground line-clamp-3 whitespace-pre-wrap">
              {truncateString(activity.text, 240)}
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
