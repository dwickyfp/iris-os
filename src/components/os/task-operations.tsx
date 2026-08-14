"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "ui/alert";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { Textarea } from "ui/textarea";
import { ContinueWorkButton } from "./continue-work-button";

type Task = {
  id: string;
  title: string;
  description?: string;
  status: "planned" | "in_progress" | "blocked" | "completed" | "cancelled";
  priority: string;
  workspaceId?: string;
  checkpoint?: string;
  nextAction?: string;
  updatedAt: string;
};
type Detail = {
  task: Task;
  activities: Array<{ id: string; type: string; createdAt: string }>;
  resources: Array<{
    id: string;
    kind: string;
    label?: string;
    referenceId: string;
  }>;
};

async function responseError(response: Response) {
  const body = await response.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : "Request failed";
}

export function TaskOperations() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [detail, setDetail] = useState<Detail>();
  const [title, setTitle] = useState("");
  const [checkpoint, setCheckpoint] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [resource, setResource] = useState("");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const response = await fetch("/api/tasks");
    if (response.ok) setTasks(await response.json());
    else setError(await responseError(response));
    setLoading(false);
  }, []);
  useEffect(() => void load(), [load]);

  async function selectTask(id: string) {
    setError(undefined);
    const response = await fetch(`/api/tasks/${id}`);
    if (!response.ok) return setError(await responseError(response));
    const value: Detail = await response.json();
    setDetail(value);
    setCheckpoint(value.task.checkpoint ?? "");
    setNextAction(value.task.nextAction ?? "");
  }

  async function createTask(event: React.FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, priority: "normal", metadata: {} }),
    });
    if (!response.ok) return setError(await responseError(response));
    const task: Task = await response.json();
    setTitle("");
    await load();
    await selectTask(task.id);
  }

  async function updateTask(input: Record<string, unknown>) {
    if (!detail) return;
    setBusy(true);
    const response = await fetch(`/api/tasks/${detail.task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      setBusy(false);
      return setError(await responseError(response));
    }
    await Promise.all([load(), selectTask(detail.task.id)]);
    setBusy(false);
  }

  async function attachResource(event: React.FormEvent) {
    event.preventDefault();
    if (!detail) return;
    const response = await fetch(`/api/tasks/${detail.task.id}/resources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "url",
        referenceId: resource,
        label: resource,
        metadata: {},
      }),
    });
    if (!response.ok) return setError(await responseError(response));
    setResource("");
    await selectTask(detail.task.id);
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6 md:p-10">
      <header className="border-b pb-6">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Task ledger
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Operational tasks
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Create durable work, checkpoint it, attach resources, and resume with
          explicit context.
        </p>
      </header>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <form
        onSubmit={createTask}
        className="flex flex-col gap-2 rounded-xl border p-4 sm:flex-row"
      >
        <Label className="sr-only" htmlFor="task-title">
          Task title
        </Label>
        <Input
          id="task-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What needs to be done?"
          required
          maxLength={240}
        />
        <Button type="submit">Create task</Button>
      </form>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <section aria-busy={loading} className="space-y-2">
          <h2 className="font-semibold">Tasks</h2>
          {loading && (
            <p className="text-sm text-muted-foreground">Loading tasks…</p>
          )}
          {tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              onClick={() => void selectTask(task.id)}
              className="w-full rounded-xl border p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="block font-medium">{task.title}</span>
              <span className="text-xs uppercase text-muted-foreground">
                {task.status.replace("_", " ")} · {task.priority}
              </span>
            </button>
          ))}
          {!loading && !tasks.length && (
            <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
              No tasks yet.
            </p>
          )}
        </section>
        <section className="space-y-4 rounded-xl border p-5">
          {!detail ? (
            <p className="text-sm text-muted-foreground">
              Select a task to inspect its checkpoint and activity.
            </p>
          ) : (
            <>
              <div>
                <h2 className="text-xl font-semibold">{detail.task.title}</h2>
                <p className="text-sm text-muted-foreground">
                  {detail.task.description || "No description"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {detail.task.status === "planned" && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void updateTask({ status: "in_progress" })}
                  >
                    Start
                  </Button>
                )}
                {detail.task.status === "in_progress" && (
                  <Button
                    size="sm"
                    disabled={busy}
                    variant="outline"
                    onClick={() => void updateTask({ status: "blocked" })}
                  >
                    Block
                  </Button>
                )}
                {detail.task.status === "blocked" && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void updateTask({ status: "in_progress" })}
                  >
                    Resume
                  </Button>
                )}
                {detail.task.status === "in_progress" && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void updateTask({ status: "completed" })}
                  >
                    Complete
                  </Button>
                )}
                {!["completed", "cancelled"].includes(detail.task.status) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void updateTask({ status: "cancelled" })}
                  >
                    Cancel
                  </Button>
                )}
                <ContinueWorkButton
                  taskId={detail.task.id}
                  workspaceId={detail.task.workspaceId}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="checkpoint">Checkpoint</Label>
                <Textarea
                  id="checkpoint"
                  value={checkpoint}
                  onChange={(event) => setCheckpoint(event.target.value)}
                  placeholder="What has been verified?"
                  rows={5}
                />
                <Label htmlFor="next-action">Exact next action</Label>
                <Textarea
                  id="next-action"
                  value={nextAction}
                  onChange={(event) => setNextAction(event.target.value)}
                  rows={3}
                />
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void updateTask({ checkpoint, nextAction })}
                >
                  Save checkpoint
                </Button>
              </div>
              <form onSubmit={attachResource} className="space-y-2">
                <Label htmlFor="task-resource">Attach URL</Label>
                <div className="flex gap-2">
                  <Input
                    id="task-resource"
                    type="url"
                    value={resource}
                    onChange={(event) => setResource(event.target.value)}
                    placeholder="https://…"
                    required
                  />
                  <Button type="submit" variant="outline">
                    Attach
                  </Button>
                </div>
              </form>
              <div>
                <h3 className="font-medium">Resources</h3>
                <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                  {detail.resources.map((item) => (
                    <li key={item.id}>
                      {item.kind}: {item.label ?? item.referenceId}
                    </li>
                  ))}
                  {!detail.resources.length && <li>No attached resources.</li>}
                </ul>
              </div>
              <div>
                <h3 className="font-medium">Activity</h3>
                <ol className="mt-2 space-y-1 text-sm text-muted-foreground">
                  {detail.activities.map((item) => (
                    <li key={item.id}>
                      {item.type} · {new Date(item.createdAt).toLocaleString()}
                    </li>
                  ))}
                </ol>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
