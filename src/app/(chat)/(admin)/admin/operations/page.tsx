import { getOperationsDiagnostics } from "lib/admin/operations";

function Panel({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ id: string; status?: string; errorCode?: string | null }>;
}) {
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">{title}</h2>
        <span className="text-sm text-muted-foreground">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No actionable records.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {rows.slice(0, 12).map((row) => (
            <li key={row.id} className="rounded-lg bg-muted/40 p-3">
              <p className="break-all font-mono text-xs">{row.id}</p>
              <p className="text-muted-foreground">
                {row.status ?? "recorded"}
                {row.errorCode ? ` · ${row.errorCode}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function AdminOperationsPage() {
  const diagnostics = await getOperationsDiagnostics();
  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6 md:p-10">
      <header className="space-y-2 border-b pb-6">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Admin diagnostics
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Operations</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Read-only visibility into silent background learning and execution.
        </p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Failed / stale activity"
          value={diagnostics.summary.failedOrStaleActivity}
        />
        <Metric
          label="Active learning"
          value={diagnostics.summary.activeLearningCandidates}
        />
        <Metric
          label="Failed promotions"
          value={diagnostics.summary.failedPromotionAttempts}
        />
        <Metric
          label="Oldest pending"
          value={
            diagnostics.summary.oldestPendingActivityAt
              ? diagnostics.summary.oldestPendingActivityAt.toISOString()
              : "None"
          }
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Activity delivery" rows={diagnostics.activity} />
        <Panel title="Learning candidates" rows={diagnostics.candidates} />
        <Panel
          title="Promotion attempts"
          rows={diagnostics.promotionAttempts}
        />
        <Panel title="Learned skills" rows={diagnostics.skills} />
        <Panel title="Automation failures" rows={diagnostics.automationRuns} />
        <Panel title="Agent failures" rows={diagnostics.agentRuns} />
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 break-all text-lg font-semibold">{value}</p>
    </div>
  );
}
