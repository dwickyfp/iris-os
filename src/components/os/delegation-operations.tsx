"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "ui/alert";
import { Button } from "ui/button";

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

export function DelegationOperations() {
  const [data, setData] = useState<Payload>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
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
          {["queued", "running"].includes(run.status) &&
            !run.cancelRequestedAt && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void cancel(run.id)}
              >
                Cancel tree
              </Button>
            )}
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
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border p-4">
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
    </div>
  );
}
