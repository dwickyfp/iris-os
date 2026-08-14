import type { MemoryGraphView, MemoryNode } from "app-types/memory";
import { describe, expect, it } from "vitest";
import {
  liftLayoutToSphere,
  projectMemoryGlobe,
  rotateMemoryGlobe,
  rotatePoint,
  shouldAnimateMemoryGlobe,
} from "./memory-graph-globe";
import {
  MEMORY_SCOPE_ROOT_ID,
  buildMemoryGraphModel,
} from "./memory-graph-model";
import type { MemoryGraphPalette } from "./memory-graph-theme";

const palette: MemoryGraphPalette = {
  scope: "rgba(1, 1, 1, 1)",
  topic: "rgba(2, 2, 2, 1)",
  claim: "rgba(3, 3, 3, 1)",
  entity: "rgba(4, 4, 4, 1)",
  superseded: "rgba(5, 5, 5, 1)",
  conflict: "rgba(6, 6, 6, 1)",
  related: "rgba(7, 7, 7, 1)",
  edge: "rgba(8, 8, 8, 1)",
  scopeEdge: "rgba(9, 9, 9, 1)",
  label: "rgba(10, 10, 10, 1)",
  hoverBackground: "rgba(11, 11, 11, 1)",
  hoverLabel: "rgba(12, 12, 12, 1)",
  hoverShadow: "rgba(13, 13, 13, 1)",
  dimmed: "rgba(14, 14, 14, 1)",
};

const memoryNode = (id: string, type: MemoryNode["type"]): MemoryNode => ({
  id,
  type,
  label: id,
  confidence: 1,
  evidenceCount: 0,
  status: "active",
});

const graph: MemoryGraphView = {
  nodes: [
    memoryNode("topic", "topic"),
    memoryNode("claim", "claim"),
    memoryNode("entity", "entity"),
  ],
  edges: [
    {
      id: "edge",
      userId: "user",
      scopeType: "global",
      scopeId: null,
      sourceId: "topic",
      sourceType: "topic",
      targetId: "claim",
      targetType: "claim",
      type: "ABOUT",
      weight: 1,
      confidence: 1,
      status: "active",
    },
  ],
  degradedSemanticSearch: false,
};

describe("memory graph globe", () => {
  it("lifts semantic nodes to a unit sphere and anchors scope at the center", () => {
    const model = buildMemoryGraphModel(graph, "Global Memory");

    liftLayoutToSphere(model);

    for (const nodeId of ["topic", "claim", "entity"]) {
      const sphere = model.getNodeAttribute(nodeId, "sphere")!;
      expect(Math.hypot(sphere.x, sphere.y, sphere.z)).toBeCloseTo(1, 10);
    }
    expect(model.getNodeAttributes(MEMORY_SCOPE_ROOT_ID)).toMatchObject({
      x: 0,
      y: 0,
      depth: 0,
    });
  });

  it("preserves radius while rotating and changes projected coordinates", () => {
    const point = { x: 0.25, y: -0.5, z: Math.sqrt(0.6875) };
    const rotated = rotatePoint(point, { x: 0.3, y: 0.8, z: 0.2 }, 0.4);

    expect(Math.hypot(rotated.x, rotated.y, rotated.z)).toBeCloseTo(1, 10);
    expect(rotated).not.toEqual(point);
  });

  it("uses depth for node scale, opacity, labels, and z-index", () => {
    const model = buildMemoryGraphModel(graph);
    liftLayoutToSphere(model);
    projectMemoryGlobe(model, palette);
    const beforeX = model.getNodeAttribute("topic", "x");

    rotateMemoryGlobe(model, { x: 0, y: 1, z: 0 }, 0.5);
    projectMemoryGlobe(model, palette);
    const after = model.getNodeAttributes("topic");

    expect(after.x).not.toBeCloseTo(beforeX, 8);
    expect(after.size).toBeGreaterThan(0);
    expect(after.zIndex).toBeGreaterThanOrEqual(0);
    expect(after.zIndex).toBeLessThanOrEqual(100);
    expect(after.color).toMatch(/^rgba\(/);
    expect(model.getNodeAttribute(MEMORY_SCOPE_ROOT_ID, "x")).toBe(0);
    expect(model.getNodeAttribute(MEMORY_SCOPE_ROOT_ID, "y")).toBe(0);
  });

  it("handles an empty and single-node graph without invalid coordinates", () => {
    const empty = buildMemoryGraphModel({
      nodes: [],
      edges: [],
      degradedSemanticSearch: false,
    });
    liftLayoutToSphere(empty);
    projectMemoryGlobe(empty, palette);
    expect(empty.order).toBe(0);

    const single = buildMemoryGraphModel({
      nodes: [memoryNode("only", "claim")],
      edges: [],
      degradedSemanticSearch: false,
    });
    liftLayoutToSphere(single);
    projectMemoryGlobe(single, palette);
    expect(single.getNodeAttributes("only")).toMatchObject({
      x: 0,
      y: 0,
    });
    expect(single.getNodeAttribute("only", "sphere")?.z).toBe(-1);
  });

  it("pauses for interaction, visibility, and reduced-motion preferences", () => {
    const active = {
      destroyed: false,
      documentHidden: false,
      reducedMotion: false,
      hoveredNode: false,
      pointerDown: false,
      nodeCount: 4,
    };

    expect(shouldAnimateMemoryGlobe(active)).toBe(true);
    expect(shouldAnimateMemoryGlobe({ ...active, hoveredNode: true })).toBe(
      false,
    );
    expect(shouldAnimateMemoryGlobe({ ...active, pointerDown: true })).toBe(
      false,
    );
    expect(shouldAnimateMemoryGlobe({ ...active, documentHidden: true })).toBe(
      false,
    );
    expect(shouldAnimateMemoryGlobe({ ...active, reducedMotion: true })).toBe(
      false,
    );
    expect(shouldAnimateMemoryGlobe({ ...active, destroyed: true })).toBe(
      false,
    );
  });
});
