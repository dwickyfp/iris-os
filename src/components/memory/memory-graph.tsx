"use client";

import { useEffect, useRef } from "react";
import forceAtlas2 from "graphology-layout-forceatlas2";
import Sigma from "sigma";
import type { MemoryGraphView, MemoryNode } from "app-types/memory";
import {
  drawMemoryNodeHover,
  MEMORY_GRAPH_LABEL_COLOR,
} from "./memory-graph-draw";
import { buildMemoryGraphModel } from "./memory-graph-model";

export function MemoryGraph({
  graph,
  onNodeClick,
  scopeLabel = "Memory",
}: {
  graph: MemoryGraphView;
  onNodeClick: (node: MemoryNode) => void;
  scopeLabel?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const onNodeClickRef = useRef(onNodeClick);
  useEffect(() => {
    onNodeClickRef.current = onNodeClick;
  }, [onNodeClick]);
  useEffect(() => {
    if (!container.current) return;
    const model = buildMemoryGraphModel(graph, scopeLabel);
    if (model.order > 1)
      forceAtlas2.assign(model, {
        iterations: Math.min(400, Math.max(120, model.order * 8)),
        settings: {
          gravity: 1.5,
          scalingRatio: 2.5,
          slowDown: 4,
          strongGravityMode: true,
          barnesHutOptimize: model.order > 100,
        },
      });
    const renderer = new Sigma(model, container.current, {
      renderEdgeLabels: false,
      labelColor: { color: MEMORY_GRAPH_LABEL_COLOR },
      labelSize: 13,
      labelWeight: "500",
      labelDensity: 0.85,
      labelGridCellSize: 80,
      labelRenderedSizeThreshold: 4,
      defaultEdgeColor: "#94a3b8",
      minEdgeThickness: 1,
      stagePadding: 48,
      zIndex: true,
      defaultDrawNodeHover: drawMemoryNodeHover,
    });
    renderer.on("clickNode", ({ node }) => {
      const memoryNode = model.getNodeAttribute(node, "node") as
        | MemoryNode
        | undefined;
      if (memoryNode) onNodeClickRef.current(memoryNode);
    });
    renderer.on("enterNode", ({ node }) => {
      renderer.setSetting("nodeReducer", (candidate, data) => {
        if (candidate === node || model.areNeighbors(candidate, node))
          return { ...data, highlighted: candidate === node, zIndex: 1 };
        return { ...data, color: "#1e293b", label: "", zIndex: 0 };
      });
      renderer.setSetting("edgeReducer", (edge, data) => {
        const [source, target] = model.extremities(edge);
        return source === node || target === node
          ? { ...data, zIndex: 1 }
          : { ...data, hidden: true };
      });
      renderer.refresh();
    });
    renderer.on("leaveNode", () => {
      renderer.setSetting("nodeReducer", null);
      renderer.setSetting("edgeReducer", null);
      renderer.refresh();
    });
    return () => renderer.kill();
  }, [graph, scopeLabel]);
  return (
    <div
      ref={container}
      className="h-[560px] w-full rounded-xl border border-slate-800 bg-slate-950 text-slate-100 shadow-inner"
      aria-label="Interactive memory graph"
    />
  );
}
