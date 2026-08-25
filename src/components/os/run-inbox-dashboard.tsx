"use client";

import { useRunInbox, type RunInboxItem } from "@/hooks/use-run-inbox";
import { AlertCircle, Inbox, RefreshCw, Route, Send, X } from "lucide-react";
import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "ui/card";
import { Label } from "ui/label";
import { Skeleton } from "ui/skeleton";
import { Textarea } from "ui/textarea";
import { fetcher } from "lib/utils";

type RunState =
  | "Understanding request"
  | "Gathering information"
  | "Working with specialist"
  | "Comparing results"
  | "Preparing output"
  | "Waiting approval"
  | "Need information"
  | "Completed"
  | "Failed"
  | "Cancelled";

type RootRun = {
  id: string;
  goalRevision: number;
  goalRequirement: { goal?: string } | null;
  createdAt: string;
  completedAt: string | null;
};

type RunProjection = {
  runId: string;
  state: RunState;
  goalRound: number;
  revision: number;
  maxGoalRounds: number | null;
  canSteer: boolean;
  childSummary: { total: number; active: number; completed: number };
};

type RunsResponse = {
  roots: RootRun[];
  projections: RunProjection[];
};

type ApiError = Error & { info?: { error?: string } };

const STATE_STYLE: Record<RunState, string> = {
  "Understanding request":
    "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  "Gathering information":
    "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  "Working with specialist":
    "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  "Comparing results":
    "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
  "Preparing output":
    "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  "Waiting approval":
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  "Need information":
    "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  Completed:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  Failed: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  Cancelled: "border-border bg-muted text-muted-foreground",
};

export function runInboxSummary(item: RunInboxItem) {
  for (const key of ["objective", "message", "text", "summary", "content"]) {
    const value = item.content[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return item.mode === "inject"
    ? "New context is available for this run."
    : "A follow-up is waiting for this run.";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

async function responseError(response: Response) {
  const body = await response.json().catch(() => null);
  const code = typeof body?.error === "string" ? body.error : "";
  if (code === "RUN_GOAL_NOT_AT_SAFE_BOUNDARY")
    return "This run left its safe boundary. Refresh and wait for the next pause before steering.";
  if (code === "RUN_GOAL_REVISION_CONFLICT")
    return "The goal changed before this update was applied. The latest run state has been loaded.";
  return "The request could not be completed. Try again.";
}

export function RunInboxDashboard() {
  const inbox = useRunInbox();
  const { mutate: mutateCache } = useSWRConfig();
  const runs = useSWR<RunsResponse>("/api/agent-runs", fetcher, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    refreshInterval: 0,
  });
  const [steeringRunId, setSteeringRunId] = useState<string>();
  const [objective, setObjective] = useState("");
  const [busyId, setBusyId] = useState<string>();
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  }>();

  const projections = new Map(
    runs.data?.projections.map((projection) => [projection.runId, projection]),
  );
  const refresh = () =>
    Promise.all([
      inbox.mutate(),
      runs.mutate(),
      mutateCache("/api/run-inbox?summary=1"),
    ]);

  async function dismiss(item: RunInboxItem) {
    setBusyId(item.id);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/run-inbox/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "dismiss" }),
      });
      if (!response.ok) {
        setMessage({ kind: "error", text: await responseError(response) });
      } else {
        await inbox.mutate(
          (items) => items?.filter((candidate) => candidate.id !== item.id),
          { revalidate: false },
        );
        await mutateCache("/api/run-inbox?summary=1");
      }
    } catch {
      setMessage({
        kind: "error",
        text: "The request could not be completed. Check your connection and try again.",
      });
    } finally {
      setBusyId(undefined);
    }
  }

  async function steer(event: React.FormEvent, run: RootRun) {
    event.preventDefault();
    if (!objective.trim()) return;
    setBusyId(run.id);
    setMessage(undefined);
    try {
      const response = await fetch("/api/run-inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "steer",
          rootRunId: run.id,
          expectedRevision: run.goalRevision,
          objective: objective.trim(),
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      if (!response.ok) {
        setMessage({ kind: "error", text: await responseError(response) });
        await refresh();
      } else {
        setObjective("");
        setSteeringRunId(undefined);
        setMessage({
          kind: "success",
          text: "The revised goal was accepted at the run's safe boundary.",
        });
        await refresh();
      }
    } catch {
      setMessage({
        kind: "error",
        text: "The request could not be completed. Check your connection and try again.",
      });
    } finally {
      setBusyId(undefined);
    }
  }

  const loading = (inbox.isLoading && !inbox.data) || runs.isLoading;
  const loadError = inbox.error || runs.error;

  return (
    <main className="mx-auto w-full max-w-7xl space-y-8 p-4 sm:p-6 lg:p-10">
      <header className="relative overflow-hidden rounded-2xl border bg-card px-5 py-7 sm:px-8 sm:py-9">
        <div className="absolute inset-y-0 right-0 hidden w-1/3 bg-gradient-to-l from-primary/10 to-transparent sm:block" />
        <div className="relative max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
            Run control
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            Runs and attention
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground sm:text-base">
            Follow active work, review incoming context, and revise goals only
            when execution reaches a safe boundary.
          </p>
        </div>
      </header>

      {(message || loadError) && (
        <Alert
          variant={message?.kind === "success" ? "default" : "destructive"}
        >
          <AlertCircle />
          <AlertTitle>
            {message?.kind === "success"
              ? "Goal updated"
              : "Unable to update runs"}
          </AlertTitle>
          <AlertDescription>
            {message?.text ?? (loadError as ApiError)?.message}
          </AlertDescription>
        </Alert>
      )}

      <section aria-labelledby="attention-heading" className="space-y-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 id="attention-heading" className="text-xl font-semibold">
              Attention inbox
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Open follow-ups and system-provided context.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={inbox.isValidating || runs.isValidating}
          >
            <RefreshCw className={inbox.isValidating ? "animate-spin" : ""} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
        {loading ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
          </div>
        ) : inbox.data?.length ? (
          <div className="grid gap-3 md:grid-cols-2">
            {inbox.data.map((item) => (
              <Card key={item.id} className="gap-4 py-5 shadow-none">
                <CardHeader className="px-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={item.mode === "inject" ? "secondary" : "outline"}
                    >
                      {item.mode === "inject" ? "Injection" : "Follow-up"}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      From {item.source}
                    </span>
                  </div>
                  <CardDescription>
                    {formatDate(item.createdAt)}
                  </CardDescription>
                  <CardAction>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Dismiss inbox item"
                      disabled={busyId === item.id}
                      onClick={() => void dismiss(item)}
                    >
                      <X />
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent className="px-5">
                  <p className="line-clamp-4 whitespace-pre-wrap text-sm leading-6">
                    {runInboxSummary(item)}
                  </p>
                  {item.goalRevision && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      Goal revision {item.goalRevision}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="flex min-h-32 items-center gap-4 rounded-xl border border-dashed p-5 text-muted-foreground">
            <Inbox className="size-5" />
            <p className="text-sm">No run needs your attention.</p>
          </div>
        )}
      </section>

      <section aria-labelledby="runs-heading" className="space-y-4">
        <div>
          <h2 id="runs-heading" className="text-xl font-semibold">
            Recent runs
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            User-safe progress derived from authoritative run state.
          </p>
        </div>
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-44 rounded-xl" />
            <Skeleton className="h-44 rounded-xl" />
          </div>
        ) : runs.data?.roots.length ? (
          <div className="space-y-3">
            {runs.data.roots.map((run) => {
              const projection = projections.get(run.id);
              if (!projection) return null;
              const isSteering = steeringRunId === run.id;
              return (
                <Card key={run.id} className="gap-4 py-5 shadow-none">
                  <CardHeader className="gap-3 px-5 sm:px-6">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className={STATE_STYLE[projection.state]}
                      >
                        {projection.state}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(run.createdAt)}
                      </span>
                    </div>
                    <CardTitle className="line-clamp-2 text-base leading-6 sm:text-lg">
                      {run.goalRequirement?.goal || "Agent run"}
                    </CardTitle>
                    <CardDescription className="flex flex-wrap gap-x-4 gap-y-1">
                      <span>
                        Round {projection.goalRound}
                        {projection.maxGoalRounds
                          ? ` of ${projection.maxGoalRounds}`
                          : ""}
                      </span>
                      <span>Revision {projection.revision}</span>
                      {projection.childSummary.total > 0 && (
                        <span>
                          {projection.childSummary.active} active specialist
                          {projection.childSummary.active === 1 ? "" : "s"}
                        </span>
                      )}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="px-5 sm:px-6">
                    {projection.canSteer ? (
                      isSteering ? (
                        <form
                          onSubmit={(event) => void steer(event, run)}
                          className="space-y-3 rounded-lg border bg-muted/30 p-4"
                        >
                          <div>
                            <Label htmlFor={`steer-${run.id}`}>
                              Revised goal
                            </Label>
                            <p className="mt-1 text-xs text-muted-foreground">
                              This replaces the current objective and advances
                              its revision.
                            </p>
                          </div>
                          <Textarea
                            id={`steer-${run.id}`}
                            value={objective}
                            onChange={(event) =>
                              setObjective(event.target.value)
                            }
                            maxLength={20_000}
                            required
                            rows={3}
                            autoFocus
                          />
                          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => {
                                setSteeringRunId(undefined);
                                setObjective("");
                              }}
                            >
                              Cancel
                            </Button>
                            <Button
                              type="submit"
                              disabled={busyId === run.id || !objective.trim()}
                            >
                              <Send /> Apply revised goal
                            </Button>
                          </div>
                        </form>
                      ) : (
                        <div className="flex flex-col gap-3 rounded-lg border border-amber-500/25 bg-amber-500/5 p-4 sm:flex-row sm:items-center sm:justify-between">
                          <p className="text-sm text-muted-foreground">
                            Execution is paused at a safe goal boundary.
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setSteeringRunId(run.id)}
                          >
                            <Route /> Steer run
                          </Button>
                        </div>
                      )
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Steering becomes available only at a safe goal boundary.
                      </p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <div className="flex min-h-40 items-center gap-4 rounded-xl border border-dashed p-5 text-muted-foreground">
            <Route className="size-5" />
            <p className="text-sm">No agent runs yet.</p>
          </div>
        )}
      </section>
    </main>
  );
}
