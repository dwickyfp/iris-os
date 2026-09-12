import { OperationsRefreshButton } from "@/components/admin/operations-refresh-button";
import { Badge } from "ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "ui/card";
import { cn } from "lib/utils";
import { getOperationsDiagnostics } from "lib/admin/operations";
import type { OperationsSnapshot } from "lib/operations/snapshot";

export const dynamic = "force-dynamic";

type HealthLevel = "healthy" | "warning" | "critical";

function healthOf(snapshot: OperationsSnapshot): {
  level: HealthLevel;
  issues: string[];
} {
  const issues: string[] = [];
  let level: HealthLevel = "healthy";

  const warn = (message: string) => {
    if (level === "healthy") level = "warning";
    issues.push(message);
  };
  const critical = (message: string) => {
    level = "critical";
    issues.push(message);
  };

  if (!snapshot.database.migrationReady)
    critical("Database migration is out of date");
  if (snapshot.verification.failed > 0)
    critical(`${snapshot.verification.failed} failed verifications`);
  if (snapshot.verification.missing > 0)
    critical(`${snapshot.verification.missing} missing verifications`);
  if (snapshot.workers.active === 0 && snapshot.workers.stale > 0)
    critical("No active workers");
  if (snapshot.leases.expired > 0)
    warn(`${snapshot.leases.expired} expired leases`);
  if (snapshot.workers.stale > 0)
    warn(`${snapshot.workers.stale} stale workers`);
  if (snapshot.activity.failed > 0)
    warn(`${snapshot.activity.failed} failed activity deliveries`);
  if (snapshot.verification.completionFailed > 0)
    warn(`${snapshot.verification.completionFailed} failed completions`);
  if (
    snapshot.budgets.exhaustedRootsLastHour +
      snapshot.budgets.exhaustedChildrenLastHour >
    0
  )
    warn("Budgets exhausted in the last hour");

  return { level, issues };
}

const HEALTH_META: Record<
  HealthLevel,
  { label: string; dot: string; badge: string }
> = {
  healthy: {
    label: "Healthy",
    dot: "bg-emerald-500",
    badge:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  warning: {
    label: "Attention",
    dot: "bg-amber-500",
    badge:
      "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  critical: {
    label: "Critical",
    dot: "bg-destructive",
    badge: "border-destructive/40 bg-destructive/10 text-destructive",
  },
};

export default async function AdminOperationsPage() {
  const snapshot = await getOperationsDiagnostics();
  const health = healthOf(snapshot);
  const meta = HEALTH_META[health.level];

  const total = (values: Record<string, number>) =>
    Object.values(values).reduce((sum, value) => sum + value, 0);
  const pendingOutboxes =
    snapshot.outboxes.dispatch +
    snapshot.outboxes.remoteCancel +
    snapshot.outboxes.parentResume;

  const kpis = [
    {
      label: "Active runs",
      value: (snapshot.runs.running ?? 0) + (snapshot.runs.queued ?? 0),
      detail: `${snapshot.runs.running ?? 0} running · ${
        snapshot.runs.queued ?? 0
      } queued · ${total(snapshot.waiting)} waiting`,
      alert: false,
    },
    {
      label: "Expired leases",
      value: snapshot.leases.expired,
      detail: `${snapshot.leases.active} active leases`,
      alert: snapshot.leases.expired > 0,
    },
    {
      label: "Pending outboxes",
      value: pendingOutboxes,
      detail: `${snapshot.outboxes.dispatch} dispatch · ${snapshot.outboxes.remoteCancel} cancel · ${snapshot.outboxes.parentResume} resume`,
      alert: false,
    },
    {
      label: "Failed activity",
      value: snapshot.activity.failed ?? 0,
      detail: `${snapshot.activity.pending ?? 0} pending · ${
        snapshot.activity.processed ?? 0
      } processed`,
      alert: (snapshot.activity.failed ?? 0) > 0,
    },
    {
      label: "Verification issues",
      value: snapshot.verification.failed + snapshot.verification.missing,
      detail: `${snapshot.verification.passed} passed · ${snapshot.verification.completionFailed} failed completions`,
      alert:
        snapshot.verification.failed > 0 || snapshot.verification.missing > 0,
    },
    {
      label: "Pending parent joins",
      value: snapshot.parentJoins.pending,
      detail: `${snapshot.parentJoins.completed} completed`,
      alert: false,
    },
    {
      label: "Active workers",
      value: snapshot.workers.active,
      detail: `${snapshot.workers.stale} stale${
        snapshot.workers.oldestHeartbeatAgeSeconds != null
          ? ` · oldest heartbeat ${formatDuration(snapshot.workers.oldestHeartbeatAgeSeconds)}`
          : ""
      }`,
      alert: snapshot.workers.stale > 0,
    },
    {
      label: "Background jobs",
      value: total(snapshot.pgBoss.jobs),
      detail: snapshot.pgBoss.installed
        ? "pg-boss installed"
        : "pg-boss absent",
      alert: false,
    },
  ];

  return (
    <main className="w-full space-y-6 p-4 md:p-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Execution, delivery, verification, A2A, and worker health. Captured{" "}
            {snapshot.capturedAt.toLocaleString()}.
          </p>
        </div>
        <OperationsRefreshButton />
      </header>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-1 py-4">
          <Badge variant="outline" className={cn("gap-1.5", meta.badge)}>
            <span className={cn("size-1.5 rounded-full", meta.dot)} />
            {meta.label}
          </Badge>
          {health.issues.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              All signals nominal.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {health.issues.join(" · ")}
            </p>
          )}
        </CardContent>
      </Card>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((kpi) => (
          <Card key={kpi.label}>
            <CardContent className="py-4">
              <p className="text-xs text-muted-foreground">{kpi.label}</p>
              <p
                className={cn(
                  "mt-1 text-2xl font-semibold tabular-nums",
                  kpi.alert && "text-destructive",
                )}
              >
                {kpi.value}
              </p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {kpi.detail}
              </p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <CountMapCard title="Run states" values={snapshot.runs} />
        <CountMapCard title="Activity delivery" values={snapshot.activity} />
        <NamedCard title="Verification">
          {(
            [
              ["passed", false],
              ["failed", true],
              ["missing", true],
              ["completionFailed", true],
            ] as const
          ).map(([key, bad]) => (
            <Row
              key={key}
              label={key}
              value={snapshot.verification[key]}
              alert={bad && snapshot.verification[key] > 0}
            />
          ))}
        </NamedCard>
        <NamedCard title="Leases & outboxes">
          <Row label="Active leases" value={snapshot.leases.active} />
          <Row
            label="Expired leases"
            value={snapshot.leases.expired}
            alert={snapshot.leases.expired > 0}
          />
          <Row label="Dispatch outbox" value={snapshot.outboxes.dispatch} />
          <Row
            label="Remote cancel outbox"
            value={snapshot.outboxes.remoteCancel}
          />
          <Row
            label="Parent resume outbox"
            value={snapshot.outboxes.parentResume}
          />
        </NamedCard>
        <NamedCard title="Budgets">
          <Row
            label="Exhausted roots"
            value={snapshot.budgets.exhaustedRoots}
          />
          <Row
            label="Exhausted children"
            value={snapshot.budgets.exhaustedChildren}
          />
          <Row
            label="Exhausted roots (1h)"
            value={snapshot.budgets.exhaustedRootsLastHour}
            alert={snapshot.budgets.exhaustedRootsLastHour > 0}
          />
          <Row
            label="Exhausted children (1h)"
            value={snapshot.budgets.exhaustedChildrenLastHour}
            alert={snapshot.budgets.exhaustedChildrenLastHour > 0}
          />
          <Row
            label="Expired reservations released"
            value={snapshot.budgets.expiredReservationsReleased}
          />
        </NamedCard>
        <NamedCard title="Delegations">
          <Row label="Total" value={snapshot.delegations.total} />
          <Row
            label="Active children"
            value={snapshot.delegations.activeChildren}
          />
          <CountRows values={snapshot.delegations.statuses} />
          <CountRows values={snapshot.delegations.depths} />
        </NamedCard>
        <NamedCard title="A2A">
          <CountRows values={snapshot.a2a.agents} empty="No agents." />
          <CountRows
            values={snapshot.a2a.delegations}
            empty="No delegations."
          />
        </NamedCard>
        <NamedCard title="Jobs & inbox">
          <Row
            label="pg-boss jobs"
            value={total(snapshot.pgBoss.jobs)}
            detail={
              snapshot.pgBoss.installed ? undefined : "pg-boss not installed"
            }
          />
          <CountRows values={snapshot.jobs} />
          <CountRows values={snapshot.runInbox} />
          <CountRows values={snapshot.intelligence} />
          <CountRows values={snapshot.capabilityHealth} />
        </NamedCard>
      </section>
    </main>
  );
}

function NamedCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">{children}</CardContent>
    </Card>
  );
}

function CountMapCard({
  title,
  values,
}: {
  title: string;
  values: Record<string, number>;
}) {
  return (
    <NamedCard title={title}>
      <CountRows values={values} />
    </NamedCard>
  );
}

function labelize(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^\w/, (c) => c.toUpperCase());
}

function formatDuration(seconds: number) {
  if (seconds >= 86_400) return `${(seconds / 86_400).toFixed(1)}d`;
  if (seconds >= 3_600) return `${(seconds / 3_600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${Math.round(seconds)}s`;
}

function Row({
  label,
  value,
  detail,
  alert,
}: {
  label: string;
  value: number;
  detail?: string;
  alert?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg px-2 py-1.5 text-sm hover:bg-muted/50">
      <span className="min-w-0 truncate text-muted-foreground">
        {labelize(label)}
        {detail && (
          <span className="ml-2 text-xs text-muted-foreground/70">
            {detail}
          </span>
        )}
      </span>
      <span
        className={cn(
          "shrink-0 font-medium tabular-nums",
          alert && "text-destructive",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function CountRows({
  values,
  empty,
}: {
  values: Record<string, number>;
  empty?: string;
}) {
  const entries = Object.entries(values).filter(([, value]) => value !== 0);
  if (entries.length === 0) {
    return empty ? (
      <p className="px-2 py-1.5 text-sm text-muted-foreground">{empty}</p>
    ) : null;
  }
  return (
    <>
      {entries.map(([label, value]) => (
        <Row key={label} label={label} value={value} />
      ))}
    </>
  );
}
