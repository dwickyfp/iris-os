"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "ui/alert";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";

type Automation = {
  id: string;
  name: string;
  status: "active" | "paused" | "archived";
  triggerType: "manual" | "schedule";
  targetType: "workflow" | "skill" | "agent";
  targetId: string;
  cron?: string;
  timezone: string;
  missedRunPolicy: "skip" | "run_once";
};
type Run = {
  id: string;
  status: string;
  attempt: number;
  errorCode?: string;
  error?: string;
  retryable: boolean;
  approvalStatus: string;
  createdAt: string;
  completedAt?: string;
};
type Target = { id: string; name: string; type: Automation["targetType"] };

async function readError(response: Response) {
  const body = await response.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : "Request failed";
}

export function AutomationOperations() {
  const [items, setItems] = useState<Automation[]>([]);
  const [selected, setSelected] = useState<{
    automation: Automation;
    runs: Run[];
  }>();
  const [name, setName] = useState("");
  const [targetId, setTargetId] = useState("");
  const [targetType, setTargetType] =
    useState<Automation["targetType"]>("workflow");
  const [triggerType, setTriggerType] =
    useState<Automation["triggerType"]>("manual");
  const [cron, setCron] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [targets, setTargets] = useState<Target[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const response = await fetch("/api/automations");
    if (response.ok) setItems(await response.json());
    else setError(await readError(response));
    setLoading(false);
  }, []);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    void Promise.all([
      fetch("/api/workflow").then((response) =>
        response.ok ? response.json() : [],
      ),
      fetch("/api/skill?type=mine").then((response) =>
        response.ok ? response.json() : [],
      ),
      fetch("/api/agent?type=mine").then((response) =>
        response.ok ? response.json() : [],
      ),
    ]).then(([workflows, skills, agents]) =>
      setTargets([
        ...workflows.map((item: { id: string; name: string }) => ({
          ...item,
          type: "workflow" as const,
        })),
        ...skills.map((item: { id: string; name: string }) => ({
          ...item,
          type: "skill" as const,
        })),
        ...agents.map((item: { id: string; name: string }) => ({
          ...item,
          type: "agent" as const,
        })),
      ]),
    );
  }, []);

  async function inspect(id: string) {
    const response = await fetch(`/api/automations/${id}`);
    if (response.ok) setSelected(await response.json());
    else setError(await readError(response));
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        targetType,
        targetId,
        triggerType,
        cron: triggerType === "schedule" ? cron : undefined,
        timezone,
        missedRunPolicy: "skip",
        approvalPolicy: "always",
        input: {},
        retryLimit: 3,
        timeoutMs: 300000,
      }),
    });
    if (!response.ok) return setError(await readError(response));
    const value: Automation = await response.json();
    setName("");
    await load();
    await inspect(value.id);
  }

  async function mutate(path: string, method = "POST", body?: unknown) {
    if (!selected) return;
    const response = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) return setError(await readError(response));
    await Promise.all([load(), inspect(selected.automation.id)]);
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6 md:p-10">
      <header className="border-b pb-6">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Execution control
        </p>
        <h1 className="mt-2 text-3xl font-semibold">Automations</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Schedule existing workflow, skill, or agent runtimes with durable
          approval and run history.
        </p>
      </header>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <form
        onSubmit={create}
        className="grid gap-3 rounded-xl border p-4 md:grid-cols-2 lg:grid-cols-3"
      >
        <div>
          <Label htmlFor="automation-name">Name</Label>
          <Input
            id="automation-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div>
          <Label htmlFor="target-type">Target type</Label>
          <select
            id="target-type"
            className="h-10 w-full rounded-md border bg-background px-3"
            value={targetType}
            onChange={(e) =>
              setTargetType(e.target.value as Automation["targetType"])
            }
          >
            <option value="workflow">Workflow</option>
            <option value="skill">Skill</option>
            <option value="agent">Agent</option>
          </select>
        </div>
        <div>
          <Label htmlFor="target-id">Target ID</Label>
          <Input
            id="target-id"
            list="automation-targets"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            placeholder="UUID from existing target"
            required
          />
          <datalist id="automation-targets">
            {targets
              .filter((target) => target.type === targetType)
              .map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name}
                </option>
              ))}
          </datalist>
        </div>
        <div>
          <Label htmlFor="trigger-type">Trigger</Label>
          <select
            id="trigger-type"
            className="h-10 w-full rounded-md border bg-background px-3"
            value={triggerType}
            onChange={(e) =>
              setTriggerType(e.target.value as Automation["triggerType"])
            }
          >
            <option value="manual">Manual</option>
            <option value="schedule">Schedule</option>
          </select>
        </div>
        {triggerType === "schedule" && (
          <>
            <div>
              <Label htmlFor="cron">Cron</Label>
              <Input
                id="cron"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="timezone">Timezone</Label>
              <Input
                id="timezone"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                required
              />
            </div>
          </>
        )}
        <div className="flex items-end">
          <Button type="submit">Create automation</Button>
        </div>
      </form>
      <div className="grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
        <section className="space-y-2" aria-busy={loading}>
          <h2 className="font-semibold">Definitions</h2>
          {items.map((item) => (
            <button
              className="w-full rounded-xl border p-4 text-left focus-visible:ring-2"
              type="button"
              key={item.id}
              onClick={() => void inspect(item.id)}
            >
              <span className="block font-medium">{item.name}</span>
              <span className="text-xs uppercase text-muted-foreground">
                {item.status} · {item.targetType} · {item.triggerType}
              </span>
            </button>
          ))}
          {!loading && !items.length && (
            <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
              No automations configured.
            </p>
          )}
        </section>
        <section className="space-y-4 rounded-xl border p-5">
          {!selected ? (
            <p className="text-sm text-muted-foreground">
              Select an automation to inspect runs.
            </p>
          ) : (
            <>
              <div>
                <h2 className="text-xl font-semibold">
                  {selected.automation.name}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {selected.automation.cron ?? "Manual trigger"} ·{" "}
                  {selected.automation.timezone} · missed runs:{" "}
                  {selected.automation.missedRunPolicy}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    void mutate(
                      `/api/automations/${selected.automation.id}/trigger`,
                    )
                  }
                >
                  Run now
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void mutate(
                      `/api/automations/${selected.automation.id}`,
                      "PATCH",
                      {
                        status:
                          selected.automation.status === "paused"
                            ? "active"
                            : "paused",
                      },
                    )
                  }
                >
                  {selected.automation.status === "paused" ? "Resume" : "Pause"}
                </Button>
              </div>
              <div>
                <h3 className="font-medium">Run history</h3>
                <ul className="mt-2 space-y-2">
                  {selected.runs.map((run) => (
                    <li
                      key={run.id}
                      className="rounded-lg bg-muted p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {run.status.replaceAll("_", " ")} · attempt{" "}
                          {run.attempt}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(run.createdAt).toLocaleString()}
                        </span>
                      </div>
                      {run.errorCode && (
                        <p className="mt-1 text-destructive">
                          {run.errorCode}: {run.error}
                        </p>
                      )}
                      <div className="mt-2 flex gap-2">
                        {run.approvalStatus === "pending" && (
                          <Button
                            size="sm"
                            onClick={() =>
                              void mutate(
                                `/api/automations/${selected.automation.id}/runs/${run.id}/approve`,
                              )
                            }
                          >
                            Approve
                          </Button>
                        )}
                        {run.retryable && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void mutate(
                                `/api/automations/${selected.automation.id}/runs/${run.id}/retry`,
                              )
                            }
                          >
                            Retry
                          </Button>
                        )}
                        {!run.completedAt && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              void mutate(
                                `/api/automations/${selected.automation.id}/runs/${run.id}`,
                                "DELETE",
                              )
                            }
                          >
                            Cancel
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                  {!selected.runs.length && (
                    <li className="text-sm text-muted-foreground">
                      No runs yet.
                    </li>
                  )}
                </ul>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
