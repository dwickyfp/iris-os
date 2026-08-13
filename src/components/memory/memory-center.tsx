"use client";

import { useEffect, useState } from "react";
import type { UserMemory } from "app-types/memory";
import { Button } from "ui/button";
import { Input } from "ui/input";

export function MemoryCenter() {
  const [memories, setMemories] = useState<UserMemory[]>([]);
  const [content, setContent] = useState("");
  const load = () =>
    fetch("/api/memory")
      .then((response) => response.json())
      .then(setMemories);
  useEffect(() => {
    load();
  }, []);
  async function add() {
    if (!content.trim()) return;
    const response = await fetch("/api/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "preference", content, confidence: 1 }),
    });
    if (response.ok) {
      setContent("");
      load();
    }
  }
  async function forget(id: string) {
    await fetch(`/api/memory/${id}`, { method: "DELETE" });
    load();
  }
  return (
    <section className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Memory Center</h1>
        <p className="text-sm text-muted-foreground">
          Manage what Iris remembers across your chats. Sensitive data is never
          captured automatically.
        </p>
      </header>
      <div className="flex gap-2">
        <Input
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="e.g. Use concise Indonesian by default"
        />
        <Button onClick={add}>Remember</Button>
      </div>
      <div className="space-y-2">
        {memories.map((memory) => (
          <div
            key={memory.id}
            className="flex items-center gap-3 rounded-lg border p-3"
          >
            <div className="min-w-0 flex-1">
              <p>{memory.content}</p>
              <p className="text-xs text-muted-foreground">
                {memory.kind} · {memory.provenance}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => forget(memory.id)}
            >
              Forget
            </Button>
          </div>
        ))}
        {memories.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No saved memories yet.
          </p>
        )}
      </div>
    </section>
  );
}
