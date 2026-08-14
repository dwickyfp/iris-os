import { describe, expect, it } from "vitest";
import type { MemoryEdge, MemoryGraphView, MemoryNode } from "app-types/memory";
import {
  buildMemoryGraphModel,
  filterMemoryGraph,
  MEMORY_SCOPE_ROOT_ID,
} from "./memory-graph-model";

function node(
  id: string,
  type: MemoryNode["type"],
  label: string,
  confidence = 1,
): MemoryNode {
  return {
    id,
    type,
    label,
    confidence,
    evidenceCount: 0,
    status: "active",
  };
}

function edge(
  id: string,
  sourceId: string,
  targetId: string,
  type: MemoryEdge["type"] = "ABOUT",
): MemoryEdge {
  return {
    id,
    userId: "user-1",
    scopeType: "global",
    scopeId: null,
    sourceId,
    sourceType: "claim",
    targetId,
    targetType: "topic",
    type,
    weight: 1,
    confidence: 1,
    status: "active",
  };
}

function graph(): MemoryGraphView {
  return {
    nodes: [
      node("claim-a", "claim", "Suka jus jambu"),
      node("topic-a", "topic", "Preferensi"),
      node("claim-b", "claim", "Suka susu"),
      node("topic-b", "topic", "Makanan dan minuman"),
    ],
    edges: [
      edge("edge-a", "claim-a", "topic-a"),
      edge("edge-b", "claim-b", "topic-b", "RELATED_TO"),
    ],
    degradedSemanticSearch: false,
  };
}

describe("memory graph model", () => {
  it("connects disconnected semantic components through a visual scope hub", () => {
    const model = buildMemoryGraphModel(graph());
    const visited = new Set<string>();
    const pending = [MEMORY_SCOPE_ROOT_ID];

    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      model.forEachNeighbor(current, (neighbor) => pending.push(neighbor));
    }

    expect(model.order).toBe(5);
    expect(model.size).toBe(4);
    expect(visited.size).toBe(model.order);
    expect(model.getNodeAttribute(MEMORY_SCOPE_ROOT_ID, "virtual")).toBe(true);
  });

  it("does not add an empty scope hub", () => {
    const model = buildMemoryGraphModel({
      nodes: [],
      edges: [],
      degradedSemanticSearch: false,
    });

    expect(model.order).toBe(0);
    expect(model.size).toBe(0);
  });

  it("uses only Sigma's registered line program for every edge", () => {
    const model = buildMemoryGraphModel(graph());
    const edgeTypes = new Set<string>();

    model.forEachEdge((_edge, attributes) => edgeTypes.add(attributes.type));

    expect(edgeTypes).toEqual(new Set(["line"]));
    expect(model.getEdgeAttribute("edge-b", "color")).toBe("#6ee7b7");
  });

  it("keeps direct neighbors when searching so relationship context remains", () => {
    const filtered = filterMemoryGraph(graph(), "jus", 0);

    expect(filtered.nodes.map((item) => item.id).sort()).toEqual([
      "claim-a",
      "topic-a",
    ]);
    expect(filtered.edges.map((item) => item.id)).toEqual(["edge-a"]);
  });
});
