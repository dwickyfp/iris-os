import { getSession } from "auth/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import {
  AutomationTable,
  IrisActivityEventTable,
  LearningCandidateTable,
  TaskTable,
  WorkspaceTable,
} from "lib/db/pg/schema.pg";
import { redirect } from "next/navigation";
import { ContinueWorkButton } from "@/components/os/continue-work-button";

export default async function OsDashboardPage() {
  const session = await getSession();
  if (!session?.user.id) redirect("/sign-in");
  const userId = session.user.id;
  const [tasks, candidates, automations, workspaces, activity] =
    await Promise.all([
      pgDb
        .select()
        .from(TaskTable)
        .where(
          and(
            eq(TaskTable.userId, userId),
            inArray(TaskTable.status, ["planned", "in_progress", "blocked"]),
          ),
        )
        .orderBy(desc(TaskTable.updatedAt))
        .limit(8),
      pgDb
        .select()
        .from(LearningCandidateTable)
        .where(
          and(
            eq(LearningCandidateTable.userId, userId),
            eq(LearningCandidateTable.status, "pending"),
          ),
        )
        .orderBy(desc(LearningCandidateTable.createdAt))
        .limit(8),
      pgDb
        .select()
        .from(AutomationTable)
        .where(
          and(
            eq(AutomationTable.userId, userId),
            eq(AutomationTable.status, "active"),
          ),
        )
        .limit(8),
      pgDb
        .select()
        .from(WorkspaceTable)
        .where(
          and(
            eq(WorkspaceTable.userId, userId),
            eq(WorkspaceTable.status, "active"),
          ),
        )
        .orderBy(desc(WorkspaceTable.updatedAt))
        .limit(6),
      pgDb
        .select()
        .from(IrisActivityEventTable)
        .where(
          and(
            eq(IrisActivityEventTable.userId, userId),
            isNull(IrisActivityEventTable.processedAt),
          ),
        )
        .orderBy(desc(IrisActivityEventTable.createdAt))
        .limit(8),
    ]);

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

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Active work</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {tasks.map((task) => (
            <article key={task.id} className="space-y-3 rounded-xl border p-4">
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

      <div className="grid gap-6 lg:grid-cols-3">
        <DashboardList
          title={`Learning inbox (${candidates.length})`}
          items={candidates.map((item) => item.title)}
          empty="Nothing needs review."
        />
        <DashboardList
          title={`Automations (${automations.length})`}
          items={automations.map(
            (item) => `${item.name} · ${item.triggerType}`,
          )}
          empty="No active automations."
        />
        <DashboardList
          title={`Attention (${activity.length})`}
          items={activity.map((item) => item.eventType)}
          empty="Background processing is caught up."
        />
      </div>

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
    </main>
  );
}

function DashboardList({
  title,
  items,
  empty,
}: {
  title: string;
  items: string[];
  empty: string;
}) {
  return (
    <section className="rounded-xl border p-4">
      <h2 className="font-semibold">{title}</h2>
      <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
        {items.map((item, index) => (
          <li key={`${item}-${index}`}>{item}</li>
        ))}
        {!items.length && <li>{empty}</li>}
      </ul>
    </section>
  );
}
