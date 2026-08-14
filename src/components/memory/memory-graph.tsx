"use client";

import type { MemoryGraphView, MemoryNode } from "app-types/memory";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { useEffect, useRef } from "react";
import Sigma from "sigma";
import { createMemoryNodeHover } from "./memory-graph-draw";
import {
  MEMORY_GLOBE_BOUNDS,
  MEMORY_GLOBE_ROTATION_SPEED,
  liftLayoutToSphere,
  organicRotationAxis,
  projectMemoryGlobe,
  rotateMemoryGlobe,
  shouldAnimateMemoryGlobe,
} from "./memory-graph-globe";
import { buildMemoryGraphModel } from "./memory-graph-model";
import { readMemoryGraphPalette, withColorAlpha } from "./memory-graph-theme";

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
    const graphContainer = container.current;
    if (!graphContainer) return;

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

    liftLayoutToSphere(model);
    let palette = readMemoryGraphPalette(graphContainer);
    projectMemoryGlobe(model, palette);

    const renderer = new Sigma(model, graphContainer, {
      renderEdgeLabels: false,
      labelColor: { color: palette.label },
      labelSize: 13,
      labelWeight: "500",
      labelDensity: 0.85,
      labelGridCellSize: 80,
      labelRenderedSizeThreshold: 4,
      defaultEdgeColor: palette.edge,
      minEdgeThickness: 1,
      stagePadding: 48,
      zIndex: true,
      defaultDrawNodeHover: createMemoryNodeHover(palette),
    });
    renderer.setCustomBBox(MEMORY_GLOBE_BOUNDS);

    let hoveredNode: string | null = null;
    let pointerDown = false;
    let animationFrame: number | null = null;
    let previousTime = performance.now();
    let elapsedTime = 0;
    let destroyed = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const phases = {
      x: Math.random() * Math.PI * 2,
      y: Math.random() * Math.PI * 2,
      z: Math.random() * Math.PI * 2,
    };

    const shouldAnimate = () =>
      shouldAnimateMemoryGlobe({
        destroyed,
        documentHidden: document.hidden,
        reducedMotion: reducedMotion.matches,
        hoveredNode: hoveredNode !== null,
        pointerDown,
        nodeCount: model.order,
      });

    const tick = (time: number) => {
      animationFrame = null;
      if (!shouldAnimate()) return;
      const deltaSeconds = Math.min(0.05, (time - previousTime) / 1000);
      previousTime = time;
      elapsedTime += deltaSeconds;
      rotateMemoryGlobe(
        model,
        organicRotationAxis(elapsedTime, phases),
        MEMORY_GLOBE_ROTATION_SPEED * deltaSeconds,
      );
      projectMemoryGlobe(model, palette);
      renderer.scheduleRefresh();
      animationFrame = requestAnimationFrame(tick);
    };

    const syncAnimation = () => {
      if (shouldAnimate()) {
        if (animationFrame === null) {
          previousTime = performance.now();
          animationFrame = requestAnimationFrame(tick);
        }
      } else if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
    };

    const updatePalette = () => {
      if (destroyed) return;
      palette = readMemoryGraphPalette(graphContainer);
      projectMemoryGlobe(model, palette);
      renderer.setSettings({
        labelColor: { color: palette.label },
        defaultEdgeColor: palette.edge,
        defaultDrawNodeHover: createMemoryNodeHover(palette),
      });
      renderer.refresh();
    };

    renderer.on("clickNode", ({ node }) => {
      const memoryNode = model.getNodeAttribute(node, "node");
      if (memoryNode) onNodeClickRef.current(memoryNode);
    });
    renderer.on("enterNode", ({ node }) => {
      hoveredNode = node;
      syncAnimation();
      renderer.setSetting("nodeReducer", (candidate, data) => {
        if (candidate === node || model.areNeighbors(candidate, node)) {
          return {
            ...data,
            label:
              candidate === node
                ? model.getNodeAttribute(candidate, "baseLabel")
                : data.label,
            highlighted: candidate === node,
            zIndex: candidate === node ? 300 : 201,
          };
        }
        return {
          ...data,
          color: withColorAlpha(palette.dimmed, 0.4),
          label: "",
          zIndex: 0,
        };
      });
      renderer.setSetting("edgeReducer", (edge, data) => {
        const [source, target] = model.extremities(edge);
        return source === node || target === node
          ? { ...data, zIndex: 202 }
          : { ...data, hidden: true };
      });
      renderer.refresh();
    });
    renderer.on("leaveNode", () => {
      hoveredNode = null;
      renderer.setSetting("nodeReducer", null);
      renderer.setSetting("edgeReducer", null);
      renderer.refresh();
      syncAnimation();
    });

    const handlePointerDown = () => {
      pointerDown = true;
      syncAnimation();
    };
    const handlePointerUp = () => {
      pointerDown = false;
      syncAnimation();
    };
    const handleVisibilityChange = () => syncAnimation();
    const handleMotionPreference = () => syncAnimation();
    graphContainer.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    reducedMotion.addEventListener("change", handleMotionPreference);

    let paletteUpdateFrame: number | null = null;
    const themeObserver = new MutationObserver(() => {
      if (paletteUpdateFrame !== null) cancelAnimationFrame(paletteUpdateFrame);
      paletteUpdateFrame = requestAnimationFrame(() => {
        paletteUpdateFrame = null;
        updatePalette();
      });
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    syncAnimation();
    return () => {
      destroyed = true;
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      if (paletteUpdateFrame !== null) cancelAnimationFrame(paletteUpdateFrame);
      themeObserver.disconnect();
      graphContainer.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      reducedMotion.removeEventListener("change", handleMotionPreference);
      renderer.kill();
    };
  }, [graph, scopeLabel]);

  return (
    <div
      ref={container}
      className="h-[560px] w-full rounded-xl border border-border bg-card text-card-foreground shadow-inner"
      aria-label="Interactive memory graph"
    />
  );
}
