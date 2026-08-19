"use client";

import type {
  AgentRunResumeInput,
  RemoteAgentCredential,
} from "app-types/remote-agent";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "ui/alert";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";
import { Input } from "ui/input";
import { Label } from "ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";

type AgentRun = {
  id: string;
  parentRunId?: string;
  status: string;
  depth: number;
  tokenBudget: number;
  errorCode?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  cancelRequestedAt?: string;
  waitingReason?: string;
  remoteMetadata?: {
    waitingRequest?: unknown;
    statusMessage?: unknown;
  } | null;
};
type Delegation = {
  id: string;
  parentRunId: string;
  childRunId: string;
  objective: string;
  status: string;
  errorCode?: string;
};
type Payload = {
  roots: AgentRun[];
  runs: AgentRun[];
  delegations: Delegation[];
  summary: { active: number; failed: number; cancellable: number };
};
type TimelinePayload = {
  events: Array<{
    id: string;
    eventType: string;
    createdAt: string;
  }>;
};

export function DelegationOperations() {
  const [data, setData] = useState<Payload>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [selectedRun, setSelectedRun] = useState<AgentRun>();
  const [timeline, setTimeline] = useState<TimelinePayload>();
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [resumeValue, setResumeValue] = useState("");
  const [credentialType, setCredentialType] =
    useState<RemoteAgentCredential["type"]>("bearer");
  const [credentialHeader, setCredentialHeader] = useState("X-API-Key");
  const [resumeBusy, setResumeBusy] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    const response = await fetch("/api/agent-runs");
    if (response.ok) setData(await response.json());
    else {
      const body = await response.json().catch(() => null);
      setError(
        typeof body?.error === "string"
          ? body.error
          : "Unable to load delegation runs",
      );
    }
    setLoading(false);
  }, []);
  useEffect(() => void load(), [load]);

  async function cancel(id: string) {
    const response = await fetch(`/api/agent-runs/${id}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      return setError(
        typeof body?.error === "string" ? body.error : "Cancellation failed",
      );
    }
    await load();
  }

  async function openRun(run: AgentRun) {
    setSelectedRun(run);
    setTimeline(undefined);
    setResumeValue("");
    setCredentialType("bearer");
    setCredentialHeader("X-API-Key");
    setTimelineLoading(true);
    const response = await fetch(`/api/agent-runs/${run.id}/timeline`);
    if (response.ok) setTimeline(await response.json());
    else setError("Unable to load run timeline");
    setTimelineLoading(false);
  }

  async function resume() {
    if (!selectedRun || !resumeValue.trim()) return;
    setResumeBusy(true);
    const body: AgentRunResumeInput =
      selectedRun.status === "waiting_input"
        ? { kind: "input", message: resumeValue }
        : {
            kind: "credential",
            credential:
              credentialType === "api_key"
                ? {
                    type: "api_key",
                    value: resumeValue,
                    headerName: credentialHeader,
                  }
                : { type: "bearer", value: resumeValue },
          };
    const response = await fetch(`/api/agent-runs/${selectedRun.id}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setResumeBusy(false);
    if (!response.ok) {
      const responseBody = await response.json().catch(() => null);
      setError(responseBody?.error ?? "Unable to resume run");
      return;
    }
    setSelectedRun(undefined);
    await load();
  }

  const remoteRequest = formatRemoteValue(
    selectedRun?.remoteMetadata?.waitingRequest,
  );
  const remoteStatus = formatRemoteValue(
    selectedRun?.remoteMetadata?.statusMessage,
  );
  const canResume =
    Boolean(resumeValue.trim()) &&
    (selectedRun?.status !== "waiting_approval" ||
      credentialType !== "api_key" ||
      Boolean(credentialHeader.trim()));

  function renderRun(run: AgentRun): React.ReactNode {
    const children =
      data?.runs.filter((item) => item.parentRunId === run.id) ?? [];
    const delegation = data?.delegations.find(
      (item) => item.childRunId === run.id,
    );
    const duration = run.startedAt
      ? Math.max(
          0,
          new Date(run.completedAt ?? Date.now()).getTime() -
            new Date(run.startedAt).getTime(),
        )
      : 0;
    return (
      <li key={run.id} className="rounded-xl border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-medium">
              {delegation?.objective ??
                (run.depth === 0 ? "Parent agent run" : "Delegated work")}
            </p>
            <p className="text-xs uppercase text-muted-foreground">
              {run.status} · depth {run.depth} · {(duration / 1000).toFixed(1)}s
              · budget {run.tokenBudget.toLocaleString()}
            </p>
          </div>
          {[
            "queued",
            "running",
            "waiting_approval",
            "waiting_input",
            "waiting_external",
          ].includes(run.status) &&
            !run.cancelRequestedAt && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void cancel(run.id)}
              >
                Cancel tree
              </Button>
            )}
          <Button size="sm" variant="ghost" onClick={() => void openRun(run)}>
            View timeline
          </Button>
        </div>
        {(run.errorCode || delegation?.errorCode) && (
          <p className="mt-2 text-sm text-destructive">
            {run.errorCode ?? delegation?.errorCode}:{" "}
            {run.error ?? "Partial delegation failure"}
          </p>
        )}
        {children.length > 0 && (
          <ol className="mt-4 space-y-3 border-l pl-4">
            {children.map(renderRun)}
          </ol>
        )}
      </li>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6 md:p-10">
      <header className="border-b pb-6">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Agent execution
        </p>
        <h1 className="mt-2 text-3xl font-semibold">Delegation tree</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Inspect child depth, duration, budget, partial failures, timeouts, and
          propagated cancellation.
        </p>
      </header>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {data && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Active" value={data.summary.active} />
          <Metric label="Failed or timed out" value={data.summary.failed} />
          <Metric label="Cancellable" value={data.summary.cancellable} />
        </div>
      )}
      <section aria-busy={loading}>
        {loading ? (
          <p className="text-sm text-muted-foreground">
            Loading delegation history…
          </p>
        ) : (
          <ol className="space-y-4">
            {data?.roots.map(renderRun)}
            {!data?.roots.length && (
              <li className="rounded-xl border border-dashed p-8 text-sm text-muted-foreground">
                No delegated agent runs yet. Delegations appear here after an
                agent invokes delegate_work.
              </li>
            )}
          </ol>
        )}
      </section>
      <Dialog
        open={Boolean(selectedRun)}
        onOpenChange={(open) => !open && setSelectedRun(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run timeline</DialogTitle>
            <DialogDescription>
              {selectedRun?.waitingReason ??
                "Execution events and delegation state changes."}
            </DialogDescription>
          </DialogHeader>
          {selectedRun && <Badge variant="outline">{selectedRun.status}</Badge>}
          {(remoteRequest || remoteStatus) && (
            <div className="grid gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
              {remoteRequest && (
                <div>
                  <p className="font-medium">Remote request</p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                    {remoteRequest}
                  </p>
                </div>
              )}
              {remoteStatus && remoteStatus !== remoteRequest && (
                <div>
                  <p className="font-medium">Remote status</p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                    {remoteStatus}
                  </p>
                </div>
              )}
            </div>
          )}
          <ol className="max-h-72 space-y-3 overflow-y-auto border-l pl-4">
            {timelineLoading && (
              <li className="text-sm text-muted-foreground">
                Loading timeline…
              </li>
            )}
            {!timelineLoading && !timeline?.events.length && (
              <li className="text-sm text-muted-foreground">
                No timeline events recorded.
              </li>
            )}
            {timeline?.events.map((event) => (
              <li key={event.id} className="text-sm">
                <p className="font-medium">{event.eventType}</p>
                <time className="text-xs text-muted-foreground">
                  {new Date(event.createdAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ol>
          {selectedRun &&
            ["waiting_input", "waiting_approval"].includes(
              selectedRun.status,
            ) && (
              <div className="grid gap-2 border-t pt-4">
                {selectedRun.status === "waiting_approval" && (
                  <>
                    <Label htmlFor="run-credential-type">Credential type</Label>
                    <Select
                      value={credentialType}
                      onValueChange={(value: RemoteAgentCredential["type"]) =>
                        setCredentialType(value)
                      }
                    >
                      <SelectTrigger id="run-credential-type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="bearer">Bearer token</SelectItem>
                        <SelectItem value="api_key">API key</SelectItem>
                      </SelectContent>
                    </Select>
                  </>
                )}
                <Label htmlFor="run-continuation">
                  {selectedRun.status === "waiting_input"
                    ? "Requested input"
                    : credentialType === "api_key"
                      ? "API key"
                      : "Bearer token"}
                </Label>
                <Input
                  id="run-continuation"
                  type={
                    selectedRun.status === "waiting_approval"
                      ? "password"
                      : "text"
                  }
                  value={resumeValue}
                  onChange={(event) => setResumeValue(event.target.value)}
                />
                {selectedRun.status === "waiting_approval" &&
                  credentialType === "api_key" && (
                    <>
                      <Label htmlFor="run-credential-header">Header name</Label>
                      <Input
                        id="run-credential-header"
                        value={credentialHeader}
                        onChange={(event) =>
                          setCredentialHeader(event.target.value)
                        }
                      />
                    </>
                  )}
              </div>
            )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSelectedRun(undefined)}>
              Close
            </Button>
            {selectedRun &&
              ["waiting_input", "waiting_approval"].includes(
                selectedRun.status,
              ) && (
                <Button
                  disabled={!canResume || resumeBusy}
                  onClick={() => void resume()}
                >
                  Resume run
                </Button>
              )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function formatRemoteValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Remote agent returned an unreadable status.";
  }
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border p-4">
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
    </div>
  );
}
