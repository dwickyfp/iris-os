"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  MemoryConflict,
  MemoryCuratorRun,
  MemoryGraphView,
  MemoryNode,
  UserMemory,
} from "app-types/memory";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "ui/tabs";
import { MemoryGraph } from "./memory-graph";

const emptyGraph: MemoryGraphView = {
  nodes: [],
  edges: [],
  degradedSemanticSearch: true,
};

export function MemoryCenter() {
  const [memories, setMemories] = useState<UserMemory[]>([]);
  const [graph, setGraph] = useState<MemoryGraphView>(emptyGraph);
  const [conflicts, setConflicts] = useState<MemoryConflict[]>([]);
  const [activity, setActivity] = useState<MemoryCuratorRun[]>([]);
  const [selected, setSelected] = useState<MemoryNode>();
  const [provenance, setProvenance] = useState<{
    evidence: any[];
    history: any[];
  }>();
  const [content, setContent] = useState("");
  const [search, setSearch] = useState("");
  const [minimumConfidence, setMinimumConfidence] = useState(0);

  const load = useCallback(async () => {
    const [memoryResponse, graphResponse, conflictResponse, activityResponse] =
      await Promise.all([
        fetch("/api/memory"),
        fetch("/api/memory/graph"),
        fetch("/api/memory/conflicts"),
        fetch("/api/memory/activity"),
      ]);
    if (memoryResponse.ok) setMemories(await memoryResponse.json());
    if (graphResponse.ok) setGraph(await graphResponse.json());
    if (conflictResponse.ok) setConflicts(await conflictResponse.json());
    if (activityResponse.ok) setActivity(await activityResponse.json());
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const visibleGraph = useMemo(() => {
    const query = search.toLocaleLowerCase("id-ID");
    const nodes = graph.nodes.filter(
      (node) =>
        node.confidence >= minimumConfidence &&
        (!query || node.label.toLocaleLowerCase("id-ID").includes(query)),
    );
    const ids = new Set(nodes.map((node) => node.id));
    return {
      ...graph,
      nodes,
      edges: graph.edges.filter(
        (edge) => ids.has(edge.sourceId) && ids.has(edge.targetId),
      ),
    };
  }, [graph, minimumConfidence, search]);

  async function add() {
    if (!content.trim()) return;
    const response = await fetch("/api/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "preference", content, confidence: 1 }),
    });
    if (response.ok) {
      setContent("");
      await load();
    }
  }
  async function forget(id: string) {
    await fetch(`/api/memory/${id}`, { method: "DELETE" });
    await load();
  }
  async function inspect(node: MemoryNode) {
    setSelected(node);
    const [expanded, source] = await Promise.all([
      fetch(`/api/memory/graph/${node.id}?depth=1`),
      fetch(`/api/memory/${node.id}/provenance?type=${node.type}`),
    ]);
    if (expanded.ok) {
      const next: MemoryGraphView = await expanded.json();
      setGraph((current) => ({
        ...next,
        nodes: [
          ...new Map(
            [...current.nodes, ...next.nodes].map((item) => [item.id, item]),
          ).values(),
        ],
        edges: [
          ...new Map(
            [...current.edges, ...next.edges].map((item) => [item.id, item]),
          ).values(),
        ],
      }));
    }
    if (source.ok) setProvenance(await source.json());
  }
  async function resolve(id: string, resolution: "source" | "target" | "both") {
    await fetch(`/api/memory/conflicts/${id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolution }),
    });
    await load();
  }

  return (
    <section className="mx-auto w-full max-w-7xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Memory Center</h1>
        <p className="text-sm text-muted-foreground">
          Curated knowledge about you, connected to its original evidence and
          kept isolated from every other user.
        </p>
      </header>
      <Tabs defaultValue="overview">
        <TabsList className="flex w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="graph">Graph</TabsTrigger>
          <TabsTrigger value="memories">Memories</TabsTrigger>
          <TabsTrigger value="conflicts">
            Conflicts ({conflicts.length})
          </TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="grid gap-4 md:grid-cols-3">
          <Metric
            label="Active memories"
            value={memories.filter((item) => item.status === "active").length}
          />
          <Metric
            label="Topics"
            value={graph.nodes.filter((item) => item.type === "topic").length}
          />
          <Metric label="Needs review" value={conflicts.length} />
          <div className="rounded-xl border p-5 md:col-span-3">
            <h2 className="font-medium">How it learns</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Each durable statement becomes one canonical claim. Repetitions
              add evidence, refinements enrich a topic, and contradictions wait
              for your decision. Chat only receives active, non-conflicting
              knowledge.
            </p>
          </div>
        </TabsContent>
        <TabsContent value="graph" className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Input
              className="max-w-sm"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search nodes"
            />
            <label className="text-sm">
              Minimum confidence{" "}
              <input
                className="ml-2 align-middle"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={minimumConfidence}
                onChange={(event) =>
                  setMinimumConfidence(Number(event.target.value))
                }
              />
            </label>
            {graph.degradedSemanticSearch && (
              <span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs text-amber-600">
                Lexical mode · pgvector unavailable
              </span>
            )}
          </div>
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <MemoryGraph graph={visibleGraph} onNodeClick={inspect} />
            <aside className="rounded-xl border p-4">
              <h2 className="font-medium">
                {selected?.label ?? "Select a topic"}
              </h2>
              {selected && (
                <>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {selected.summary ||
                      selected.detail ||
                      `${Math.round(selected.confidence * 100)}% confidence`}
                  </p>
                  <h3 className="mt-5 text-sm font-medium">Evidence</h3>
                  <div className="mt-2 space-y-2">
                    {provenance?.evidence.map((item) => (
                      <p key={item.id} className="rounded border p-2 text-xs">
                        {item.excerpt}
                      </p>
                    ))}
                    {provenance?.evidence.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        No source pointer.
                      </p>
                    )}
                  </div>
                  <p className="mt-4 text-xs text-muted-foreground">
                    {provenance?.history.length ?? 0} recorded versions
                  </p>
                </>
              )}
            </aside>
          </div>
        </TabsContent>
        <TabsContent value="memories" className="space-y-4">
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
                    {memory.kind} · {memory.provenance} · v{memory.version} ·{" "}
                    {Math.round(memory.confidence * 100)}%
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
        </TabsContent>
        <TabsContent value="conflicts" className="space-y-3">
          {conflicts.map((conflict) => (
            <div
              key={conflict.edge.id}
              className="rounded-xl border border-red-500/30 p-4"
            >
              <p className="text-sm">
                <span className="font-medium">{conflict.source?.label}</span>{" "}
                conflicts with{" "}
                <span className="font-medium">{conflict.target?.label}</span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {conflict.edge.reason}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => resolve(conflict.edge.id, "source")}
                >
                  Keep new statement
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => resolve(conflict.edge.id, "target")}
                >
                  Keep existing statement
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => resolve(conflict.edge.id, "both")}
                >
                  Keep both
                </Button>
              </div>
            </div>
          ))}
          {conflicts.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No unresolved conflicts.
            </p>
          )}
        </TabsContent>
        <TabsContent value="activity" className="space-y-2">
          {activity.map((run) => (
            <div
              key={run.id}
              className="flex justify-between rounded-lg border p-3 text-sm"
            >
              <span>
                {run.jobType} · {run.status}
              </span>
              <span className="text-muted-foreground">
                {new Date(run.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
          {activity.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No curator activity yet.
            </p>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-3xl font-semibold">{value}</p>
    </div>
  );
}
