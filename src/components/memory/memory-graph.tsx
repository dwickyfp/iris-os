"use client";

import { useEffect, useRef } from "react";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import Sigma from "sigma";
import type { MemoryGraphView, MemoryNode } from "app-types/memory";

const colors = {
  topic: "#8b5cf6",
  claim: "#3b82f6",
  entity: "#22c55e",
};

export function MemoryGraph({
  graph,
  onNodeClick,
}: { graph: MemoryGraphView; onNodeClick: (node: MemoryNode) => void }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const model = new Graph();
    graph.nodes.forEach((node, index) => {
      const angle = (index / Math.max(1, graph.nodes.length)) * Math.PI * 2;
      model.addNode(node.id, {
        label: node.label,
        x: Math.cos(angle),
        y: Math.sin(angle),
        size: node.type === "topic" ? 14 : node.type === "claim" ? 8 : 5,
        color: node.status === "superseded" ? "#64748b" : colors[node.type],
        node,
      });
    });
    graph.edges.forEach((edge) => {
      if (!model.hasNode(edge.sourceId) || !model.hasNode(edge.targetId))
        return;
      model.addEdgeWithKey(edge.id, edge.sourceId, edge.targetId, {
        color: edge.type === "CONTRADICTS" ? "#ef4444" : "#64748b",
        size: Math.max(0.5, edge.weight * 2),
        type: edge.type === "RELATED_TO" ? "dashed" : "line",
        label: edge.type,
      });
    });
    if (model.order > 1)
      forceAtlas2.assign(model, {
        iterations: Math.min(150, 30 + model.order),
        settings: { gravity: 1, scalingRatio: 4, slowDown: 5 },
      });
    const renderer = new Sigma(model, container.current, {
      renderEdgeLabels: false,
      labelDensity: 0.12,
      labelGridCellSize: 100,
    });
    renderer.on("clickNode", ({ node }) =>
      onNodeClick(model.getNodeAttribute(node, "node") as MemoryNode),
    );
    return () => renderer.kill();
  }, [graph, onNodeClick]);
  return (
    <div
      ref={container}
      className="h-[560px] w-full rounded-xl bg-slate-950"
      aria-label="Interactive memory graph"
    />
  );
}
