import { getSession } from "auth/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import {
  AutomationTable,
  AutomationRunTable,
  AgentRunTable,
  IrisActivityEventTable,
  LearningCandidateTable,
  TaskTable,
  WorkspaceTable,
} from "lib/db/pg/schema.pg";
import { isV2FeatureEnabled } from "lib/feature-flags";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ContinueWorkButton } from "@/components/os/continue-work-button";

export default async function OsDashboardPage() {
  const session = await getSession();
  if (!session?.user.id) redirect("/sign-in");
  const userId = session.user.id;
  const flags = {
    workspaces: isV2FeatureEnabled("workspaces"),
    learning: isV2FeatureEnabled("learning"),
    automation: isV2FeatureEnabled("automation"),
    delegation: isV2FeatureEnabled("delegation"),
  };
  if (!Object.values(flags).some(Boolean)) notFound();
  const [
    tasks,
    candidates,
    automations,
    workspaces,
    activity,
    runs,
    agentRuns,
  ] = await Promise.all([
    flags.workspaces
      ? pgDb
          .select()
          .from(TaskTable)
          .where(
            and(
              eq(TaskTable.userId, userId),
              inArray(TaskTable.status, ["planned", "in_progress", "blocked"]),
            ),
          )
          .orderBy(desc(TaskTable.updatedAt))
          .limit(8)
      : Promise.resolve([]),
    flags.learning
      ? pgDb
          .select()
          .from(LearningCandidateTable)
          .where(
            and(
              eq(LearningCandidateTable.userId, userId),
              eq(LearningCandidateTable.status, "pending"),
            ),
          )
          .orderBy(desc(LearningCandidateTable.createdAt))
          .limit(8)
      : Promise.resolve([]),
    flags.automation
      ? pgDb
          .select()
          .from(AutomationTable)
          .where(
            and(
              eq(AutomationTable.userId, userId),
              eq(AutomationTable.status, "active"),
            ),
          )
          .limit(8)
      : Promise.resolve([]),
    flags.workspaces
      ? pgDb
          .select()
          .from(WorkspaceTable)
          .where(
            and(
              eq(WorkspaceTable.userId, userId),
              eq(WorkspaceTable.status, "active"),
            ),
          )
          .orderBy(desc(WorkspaceTable.updatedAt))
          .limit(6)
      : Promise.resolve([]),
    flags.learning
      ? pgDb
          .select()
          .from(IrisActivityEventTable)
          .where(
            and(
              eq(IrisActivityEventTable.userId, userId),
              isNull(IrisActivityEventTable.processedAt),
            ),
          )
          .orderBy(desc(IrisActivityEventTable.createdAt))
          .limit(8)
      : Promise.resolve([]),
    flags.automation
      ? pgDb
          .select()
          .from(AutomationRunTable)
          .where(eq(AutomationRunTable.userId, userId))
          .orderBy(desc(AutomationRunTable.createdAt))
          .limit(20)
      : Promise.resolve([]),
    flags.delegation
      ? pgDb
          .select()
          .from(AgentRunTable)
          .where(eq(AgentRunTable.userId, userId))
          .orderBy(desc(AgentRunTable.createdAt))
          .limit(20)
      : Promise.resolve([]),
  ]);

  const awaitingApproval = runs.filter(
    (run) => run.status === "awaiting_approval",
  ).length;
  const failures = [...runs, ...agentRuns].filter((run) =>
    ["failed", "timed_out"].includes(run.status),
  ).length;
  const retries = runs.filter((run) => run.status === "retry_scheduled").length;
  const stuck = activity.filter(
    (event) =>
      event.processingStatus === "processing" &&
      event.claimExpiresAt &&
      event.claimExpiresAt < new Date(),
  ).length;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-8 p-6 md:p-10">
      <header className="space-y-2 border-b pb-6">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Iris operating surface
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Work, memory, and attention
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Resume active work, review what Iris learned, and inspect durable
          background operations.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Awaiting approval" value={awaitingApproval} />
        <Metric label="Failures / timeouts" value={failures} />
        <Metric label="Retry scheduled" value={retries} />
        <Metric label="Stuck jobs" value={stuck} />
      </div>

      {flags.workspaces && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Active work</h2>
            <Link
              className="text-sm underline underline-offset-4"
              href="/tasks"
            >
              Open task ledger
            </Link>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {tasks.map((task) => (
              <article
                key={task.id}
                className="space-y-3 rounded-xl border p-4"
              >
                <div>
                  <p className="font-medium">{task.title}</p>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {task.status.replace("_", " ")} · {task.priority}
                  </p>
                </div>
                <p className="text-sm text-muted-foreground">
                  {task.nextAction ??
                    task.checkpoint ??
                    "No next action recorded."}
                </p>
                <ContinueWorkButton
                  taskId={task.id}
                  workspaceId={task.workspaceId}
                />
              </article>
            ))}
            {!tasks.length && (
              <p className="text-sm text-muted-foreground">No active tasks.</p>
            )}
          </div>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <DashboardList
          title={`Learning inbox (${candidates.length})`}
          items={candidates.map((item) => item.title)}
          empty="Nothing needs review."
          href={flags.learning ? "/learning" : undefined}
          disabled={!flags.learning}
        />
        <DashboardList
          title={`Automations (${automations.length})`}
          items={automations.map(
            (item) => `${item.name} · ${item.triggerType}`,
          )}
          empty="No active automations."
          href={flags.automation ? "/automations" : undefined}
          disabled={!flags.automation}
        />
        <DashboardList
          title={`Attention (${activity.length})`}
          items={activity.map((item) => item.eventType)}
          empty="Background processing is caught up."
          href={flags.delegation ? "/delegations" : undefined}
          disabled={!flags.delegation}
        />
      </div>

      {flags.workspaces && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Recent workspaces</h2>
          <div className="flex flex-wrap gap-2">
            {workspaces.map((workspace) => (
              <span
                key={workspace.id}
                className="rounded-full border px-3 py-1.5 text-sm"
              >
                {workspace.name}
              </span>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function DashboardList({
  title,
  items,
  empty,
  href,
  disabled,
}: {
  title: string;
  items: string[];
  empty: string;
  href?: string;
  disabled?: boolean;
}) {
  return (
    <section className="rounded-xl border p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        {href && (
          <Link className="text-xs underline underline-offset-4" href={href}>
            Open
          </Link>
        )}
      </div>
      <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
        {items.map((item, index) => (
          <li key={`${item}-${index}`}>{item}</li>
        ))}
        {!items.length && (
          <li>
            {disabled ? "Feature is disabled in this environment." : empty}
          </li>
        )}
      </ul>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <section className="rounded-xl border p-4">
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
    </section>
  );
}
