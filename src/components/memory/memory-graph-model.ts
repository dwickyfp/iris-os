import type { MemoryGraphView, MemoryNode } from "app-types/memory";
import Graph from "graphology";
import type { Point3D } from "./memory-graph-globe";
import type {
  MemoryEdgeColorRole,
  MemoryNodeColorRole,
} from "./memory-graph-theme";

export const MEMORY_SCOPE_ROOT_ID = "__memory_scope_root__";

export interface MemoryGraphNodeAttributes {
  x: number;
  y: number;
  size: number;
  label: string;
  baseLabel: string;
  baseSize: number;
  colorRole: MemoryNodeColorRole;
  color?: string;
  depth?: number;
  node?: MemoryNode;
  sphere?: Point3D;
  virtual: boolean;
  zIndex?: number;
}

export interface MemoryGraphEdgeAttributes {
  colorRole: MemoryEdgeColorRole;
  color?: string;
  label: string;
  size: number;
  type: "line";
  virtual: boolean;
  zIndex?: number;
}

export type MemoryGraphModel = Graph<
  MemoryGraphNodeAttributes,
  MemoryGraphEdgeAttributes
>;

export function filterMemoryGraph(
  graph: MemoryGraphView,
  search: string,
  minimumConfidence: number,
): MemoryGraphView {
  const eligible = new Set(
    graph.nodes
      .filter((node) => node.confidence >= minimumConfidence)
      .map((node) => node.id),
  );
  const query = search.trim().toLocaleLowerCase("id-ID");
  if (!query) {
    return {
      ...graph,
      nodes: graph.nodes.filter((node) => eligible.has(node.id)),
      edges: graph.edges.filter(
        (edge) => eligible.has(edge.sourceId) && eligible.has(edge.targetId),
      ),
    };
  }

  const visible = new Set(
    graph.nodes
      .filter(
        (node) =>
          eligible.has(node.id) &&
          node.label.toLocaleLowerCase("id-ID").includes(query),
      )
      .map((node) => node.id),
  );
  for (const edge of graph.edges) {
    if (visible.has(edge.sourceId) && eligible.has(edge.targetId))
      visible.add(edge.targetId);
    if (visible.has(edge.targetId) && eligible.has(edge.sourceId))
      visible.add(edge.sourceId);
  }

  return {
    ...graph,
    nodes: graph.nodes.filter((node) => visible.has(node.id)),
    edges: graph.edges.filter(
      (edge) => visible.has(edge.sourceId) && visible.has(edge.targetId),
    ),
  };
}

export function buildMemoryGraphModel(
  graph: MemoryGraphView,
  scopeLabel = "Memory",
) {
  const model: MemoryGraphModel = new Graph();
  graph.nodes.forEach((node, index) => {
    const angle = (index / Math.max(1, graph.nodes.length)) * Math.PI * 2;
    const baseSize = node.type === "topic" ? 13 : node.type === "claim" ? 8 : 6;
    model.addNode(node.id, {
      label: node.label,
      baseLabel: node.label,
      x: Math.cos(angle),
      y: Math.sin(angle),
      size: baseSize,
      baseSize,
      colorRole: node.status === "superseded" ? "superseded" : node.type,
      node,
      virtual: false,
    });
  });
  graph.edges.forEach((edge) => {
    if (!model.hasNode(edge.sourceId) || !model.hasNode(edge.targetId)) return;
    model.addEdgeWithKey(edge.id, edge.sourceId, edge.targetId, {
      colorRole:
        edge.type === "CONTRADICTS"
          ? "conflict"
          : edge.type === "RELATED_TO"
            ? "related"
            : "default",
      size: Math.max(1, edge.weight * 2.2),
      type: "line",
      label: edge.type,
      virtual: false,
    });
  });

  if (model.order === 0) return model;

  const components: string[][] = [];
  const unseen = new Set(model.nodes());
  while (unseen.size) {
    const first = unseen.values().next().value as string;
    const component: string[] = [];
    const pending = [first];
    unseen.delete(first);
    while (pending.length) {
      const current = pending.pop()!;
      component.push(current);
      model.forEachNeighbor(current, (neighbor) => {
        if (!unseen.delete(neighbor)) return;
        pending.push(neighbor);
      });
    }
    components.push(component);
  }

  model.addNode(MEMORY_SCOPE_ROOT_ID, {
    label: scopeLabel,
    baseLabel: scopeLabel,
    x: 0,
    y: 0,
    size: 17,
    baseSize: 17,
    colorRole: "scope",
    virtual: true,
  });
  components.forEach((component, index) => {
    const representative =
      component.find(
        (id) =>
          (model.getNodeAttribute(id, "node") as MemoryNode | undefined)
            ?.type === "topic",
      ) ?? component[0];
    model.addUndirectedEdgeWithKey(
      `__memory_scope_edge__${index}`,
      MEMORY_SCOPE_ROOT_ID,
      representative,
      {
        colorRole: "scope",
        size: 0.8,
        type: "line",
        label: "SCOPE",
        virtual: true,
      },
    );
  });

  return model;
}
