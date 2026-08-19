import { getOperationsDiagnostics } from "lib/admin/operations";

export default async function AdminOperationsPage() {
  const snapshot = await getOperationsDiagnostics();
  const metrics = [
    ["Queued runs", snapshot.runs.queued ?? 0],
    ["Running runs", snapshot.runs.running ?? 0],
    ["Waiting runs", total(snapshot.waiting)],
    ["Expired leases", snapshot.leases.expired],
    ["Pending outboxes", total(snapshot.outboxes)],
    ["Failed activity", snapshot.activity.failed ?? 0],
    ["Failed verification", snapshot.verification.failed],
    ["Missing verification", snapshot.verification.missing],
    ["Pending parent joins", snapshot.parentJoins.pending],
    ["Active workers", snapshot.workers.active],
    ["Stale workers", snapshot.workers.stale],
    ["pg-boss jobs", total(snapshot.pgBoss.jobs)],
  ] as const;
  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6 md:p-10">
      <header className="space-y-2 border-b pb-6">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Admin diagnostics
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Operations</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Aggregate execution, delivery, verification, A2A, and worker health.
          Captured {snapshot.capturedAt.toLocaleString()}.
        </p>
      </header>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map(([label, value]) => (
          <Metric key={label} label={label} value={value} />
        ))}
      </section>
      <section className="grid gap-4 lg:grid-cols-2">
        <Breakdown title="Run states" values={snapshot.runs} />
        <Breakdown title="Activity delivery" values={snapshot.activity} />
        <Breakdown title="A2A agents" values={snapshot.a2a.agents} />
        <Breakdown title="A2A delegations" values={snapshot.a2a.delegations} />
      </section>
    </main>
  );
}

function total(values: Record<string, number>) {
  return Object.values(values).reduce((sum, value) => sum + value, 0);
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border p-4">
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
    </div>
  );
}

function Breakdown({
  title,
  values,
}: {
  title: string;
  values: Record<string, number>;
}) {
  return (
    <div className="rounded-xl border p-4">
      <h2 className="font-semibold">{title}</h2>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
        {Object.entries(values).map(([label, value]) => (
          <div
            key={label}
            className="flex justify-between rounded bg-muted/40 p-2"
          >
            <dt>{label.replaceAll("_", " ")}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
        {Object.keys(values).length === 0 && (
          <p className="text-muted-foreground">No records.</p>
        )}
      </dl>
    </div>
  );
}
