"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "ui/alert";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { Switch } from "ui/switch";
import { Textarea } from "ui/textarea";

type Scope = "global" | "workspace" | "task" | "agent";
type Candidate = {
  id: string;
  candidateType: "memory" | "skill" | "automation";
  title: string;
  confidence: number;
  evidenceCount: number;
  scopeType: Scope;
  scopeId: string | null;
  proposedPayload: Record<string, unknown>;
};
type Observation = {
  id: string;
  summary: string;
  observationType: string;
  confidence: number;
  createdAt: string;
};
type CandidateRow = {
  candidate: Candidate;
  observation: Observation;
  evidence: Observation[];
};
type Settings = {
  enabled: boolean;
  allowedScopes: Scope[];
  allowedCategories: Array<"memory" | "skill" | "automation">;
  retentionDays: number;
  autonomyLevel: number;
};

async function readError(response: Response) {
  const body = await response.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : "Request failed";
}

export function LearningInbox({
  developerMode = false,
}: { developerMode?: boolean }) {
  const [rows, setRows] = useState<CandidateRow[]>([]);
  const [settings, setSettings] = useState<Settings>();
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>(
    {},
  );
  const [scopeIds, setScopeIds] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [candidateResponse, settingsResponse] = await Promise.all([
      fetch("/api/learning/candidates?status=pending"),
      fetch("/api/learning/settings"),
    ]);
    if (candidateResponse.ok) {
      const nextRows: CandidateRow[] = await candidateResponse.json();
      setRows(nextRows);
      setDrafts(
        Object.fromEntries(
          nextRows.map(({ candidate }) => [
            candidate.id,
            candidate.proposedPayload,
          ]),
        ),
      );
    } else setError(await readError(candidateResponse));
    if (settingsResponse.ok) setSettings(await settingsResponse.json());
    setLoading(false);
  }, []);
  useEffect(() => void load(), [load]);

  async function review(
    id: string,
    action: "confirm" | "edit" | "ignore" | "change_scope",
    payload: Record<string, unknown> = {},
  ) {
    setError(undefined);
    const response = await fetch(`/api/learning/candidates/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, payload }),
    });
    if (!response.ok) return setError(await readError(response));
    await load();
  }

  async function saveSettings(next: Partial<Settings>) {
    const response = await fetch("/api/learning/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
    if (!response.ok) return setError(await readError(response));
    setSettings(await response.json());
  }

  function updateDraft(id: string, key: string, value: unknown) {
    setDrafts((current) => ({
      ...current,
      [id]: { ...current[id], [key]: value },
    }));
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6 md:p-10">
      <header className="border-b pb-6">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Review queue
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Learning inbox
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Evidence remains reviewable. Permission is never expanded by learning.
        </p>
      </header>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {settings && (
        <section
          className="space-y-3 rounded-xl border p-5"
          aria-labelledby="learning-settings"
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 id="learning-settings" className="font-semibold">
                Learning controls
              </h2>
              <p className="text-sm text-muted-foreground">
                Control collection before events become candidates.
              </p>
            </div>
            <Switch
              checked={settings.enabled}
              onCheckedChange={(enabled) => void saveSettings({ enabled })}
              aria-label="Enable background learning"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="retention-days">Rejection retention (days)</Label>
              <Input
                id="retention-days"
                type="number"
                min={1}
                max={3650}
                value={settings.retentionDays}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    retentionDays: Number(event.target.value),
                  })
                }
                onBlur={() =>
                  void saveSettings({ retentionDays: settings.retentionDays })
                }
              />
            </div>
            <div>
              <Label htmlFor="autonomy-level">Autonomy level (0–4)</Label>
              <Input
                id="autonomy-level"
                type="number"
                min={0}
                max={4}
                value={settings.autonomyLevel}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    autonomyLevel: Number(event.target.value),
                  })
                }
                onBlur={() =>
                  void saveSettings({ autonomyLevel: settings.autonomyLevel })
                }
              />
            </div>
          </div>
        </section>
      )}
      <section className="space-y-3" aria-busy={loading}>
        {loading && (
          <p className="text-sm text-muted-foreground">Loading candidates…</p>
        )}
        {rows.map(({ candidate, evidence }) => {
          const draft = drafts[candidate.id] ?? candidate.proposedPayload;
          return (
            <article
              key={candidate.id}
              className="space-y-4 rounded-xl border p-5"
            >
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {candidate.candidateType} · {candidate.scopeType}
                  {candidate.scopeId ? `:${candidate.scopeId.slice(0, 8)}` : ""}
                </p>
                <h2 className="mt-1 font-medium">{candidate.title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {candidate.confidence}% confidence from{" "}
                  {candidate.evidenceCount} evidence item
                  {candidate.evidenceCount === 1 ? "" : "s"}. Confidence weighs
                  recurrence, recency, consistency, corrections, and successful
                  outcomes.
                </p>
              </div>
              <CandidateEditor
                candidate={candidate}
                draft={draft}
                update={(key, value) => updateDraft(candidate.id, key, value)}
              />
              <details className="text-sm">
                <summary className="cursor-pointer font-medium">
                  Evidence ({evidence.length})
                </summary>
                <ol className="mt-2 space-y-2">
                  {evidence.map((item) => (
                    <li key={item.id} className="rounded-lg bg-muted p-3">
                      <p>{item.summary}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {item.observationType} ·{" "}
                        {new Date(item.createdAt).toLocaleString()}
                      </p>
                    </li>
                  ))}
                </ol>
              </details>
              <div className="grid gap-2 sm:grid-cols-[160px_1fr_auto]">
                <select
                  aria-label="New exact scope"
                  className="h-9 rounded-md border bg-background px-2"
                  defaultValue={candidate.scopeType}
                  id={`scope-${candidate.id}`}
                >
                  <option value="global">Global</option>
                  <option value="workspace">Workspace</option>
                  <option value="task">Task</option>
                  <option value="agent">Agent</option>
                </select>
                <Input
                  aria-label="Scope UUID"
                  placeholder="Required for non-global scope"
                  value={scopeIds[candidate.id] ?? candidate.scopeId ?? ""}
                  onChange={(event) =>
                    setScopeIds((current) => ({
                      ...current,
                      [candidate.id]: event.target.value,
                    }))
                  }
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const element = document.getElementById(
                      `scope-${candidate.id}`,
                    ) as HTMLSelectElement;
                    const scopeType = element.value as Scope;
                    void review(candidate.id, "change_scope", {
                      scopeType,
                      scopeId:
                        scopeType === "global"
                          ? null
                          : (scopeIds[candidate.id] ?? candidate.scopeId),
                    });
                  }}
                >
                  Change scope
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => void review(candidate.id, "confirm", draft)}
                >
                  Confirm
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void review(candidate.id, "edit", draft)}
                >
                  Save edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void review(candidate.id, "ignore")}
                >
                  Ignore
                </Button>
              </div>
              {developerMode && (
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Developer JSON
                  </summary>
                  <pre className="mt-2 overflow-auto rounded-lg bg-muted p-3 text-xs">
                    {JSON.stringify({ candidate, evidence }, null, 2)}
                  </pre>
                </details>
              )}
            </article>
          );
        })}
        {!loading && !rows.length && (
          <p className="rounded-xl border border-dashed p-8 text-sm text-muted-foreground">
            The inbox is clear.
          </p>
        )}
      </section>
    </main>
  );
}

function CandidateEditor({
  candidate,
  draft,
  update,
}: {
  candidate: Candidate;
  draft: Record<string, unknown>;
  update: (key: string, value: unknown) => void;
}) {
  if (candidate.candidateType === "memory")
    return (
      <div className="space-y-2">
        <Label htmlFor={`content-${candidate.id}`}>Durable memory</Label>
        <Textarea
          id={`content-${candidate.id}`}
          rows={4}
          value={String(draft.content ?? "")}
          onChange={(event) => update("content", event.target.value)}
        />
      </div>
    );
  if (candidate.candidateType === "skill")
    return (
      <div className="grid gap-3">
        <div>
          <Label htmlFor={`name-${candidate.id}`}>Skill name</Label>
          <Input
            id={`name-${candidate.id}`}
            value={String(draft.name ?? "")}
            onChange={(event) => update("name", event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor={`description-${candidate.id}`}>Description</Label>
          <Textarea
            id={`description-${candidate.id}`}
            value={String(draft.description ?? "")}
            onChange={(event) => update("description", event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor={`body-${candidate.id}`}>Instructions</Label>
          <Textarea
            id={`body-${candidate.id}`}
            rows={7}
            value={String(draft.body ?? "")}
            onChange={(event) => update("body", event.target.value)}
          />
        </div>
      </div>
    );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <Label htmlFor={`name-${candidate.id}`}>Automation name</Label>
        <Input
          id={`name-${candidate.id}`}
          value={String(draft.name ?? "")}
          onChange={(event) => update("name", event.target.value)}
        />
      </div>
      <div>
        <Label htmlFor={`target-${candidate.id}`}>Target ID</Label>
        <Input
          id={`target-${candidate.id}`}
          value={String(draft.targetId ?? "")}
          onChange={(event) => update("targetId", event.target.value)}
        />
      </div>
      <div>
        <Label htmlFor={`cron-${candidate.id}`}>Cron</Label>
        <Input
          id={`cron-${candidate.id}`}
          value={String(draft.cron ?? "")}
          onChange={(event) => update("cron", event.target.value)}
        />
      </div>
      <div>
        <Label htmlFor={`timezone-${candidate.id}`}>Timezone</Label>
        <Input
          id={`timezone-${candidate.id}`}
          value={String(draft.timezone ?? "UTC")}
          onChange={(event) => update("timezone", event.target.value)}
        />
      </div>
    </div>
  );
}
