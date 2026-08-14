"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "ui/button";
import { Textarea } from "ui/textarea";

type CandidateRow = {
  candidate: {
    id: string;
    candidateType: "memory" | "skill" | "automation";
    title: string;
    confidence: number;
    proposedPayload: Record<string, unknown>;
  };
  observation: { evidence: Record<string, unknown> };
};

export function LearningInbox() {
  const [rows, setRows] = useState<CandidateRow[]>([]);
  const [editing, setEditing] = useState<string>();
  const [payload, setPayload] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/learning/candidates?status=pending");
    if (response.ok) setRows(await response.json());
  }, []);
  useEffect(() => void load(), [load]);

  async function review(
    id: string,
    action: "confirm" | "edit" | "ignore",
    nextPayload: Record<string, unknown> = {},
  ) {
    const response = await fetch(`/api/learning/candidates/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, payload: nextPayload }),
    });
    if (response.ok) {
      setEditing(undefined);
      await load();
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6 md:p-10">
      <header className="border-b pb-6">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Review queue
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Learning inbox
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Nothing is promoted into durable memory, skills, or automation until
          you approve it.
        </p>
      </header>
      <div className="space-y-3">
        {rows.map(({ candidate, observation }) => (
          <article
            key={candidate.id}
            className="space-y-4 rounded-xl border p-5"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {candidate.candidateType} · {candidate.confidence}% confidence
                </p>
                <h2 className="mt-1 font-medium">{candidate.title}</h2>
              </div>
            </div>
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer">
                Evidence and proposal
              </summary>
              <pre className="mt-2 overflow-auto rounded-lg bg-muted p-3 text-xs">
                {JSON.stringify(
                  {
                    proposal: candidate.proposedPayload,
                    evidence: observation.evidence,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            {editing === candidate.id && (
              <Textarea
                value={payload}
                onChange={(event) => setPayload(event.target.value)}
                rows={7}
                aria-label="Edit candidate JSON"
              />
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => review(candidate.id, "confirm")}>
                Confirm
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (editing === candidate.id) {
                    void review(candidate.id, "edit", JSON.parse(payload));
                  } else {
                    setEditing(candidate.id);
                    setPayload(
                      JSON.stringify(candidate.proposedPayload, null, 2),
                    );
                  }
                }}
              >
                {editing === candidate.id ? "Save edit" : "Edit"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => review(candidate.id, "ignore")}
              >
                Ignore
              </Button>
            </div>
          </article>
        ))}
        {!rows.length && (
          <p className="text-sm text-muted-foreground">The inbox is clear.</p>
        )}
      </div>
    </main>
  );
}
