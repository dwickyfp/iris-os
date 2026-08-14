import type { MemoryGraphModel } from "./memory-graph-model";
import { MEMORY_SCOPE_ROOT_ID } from "./memory-graph-model";
import {
  type MemoryGraphPalette,
  edgeColor,
  nodeColor,
  withColorAlpha,
} from "./memory-graph-theme";

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export const MEMORY_GLOBE_ROTATION_SPEED = 0.08;
export const MEMORY_GLOBE_BOUNDS = {
  x: [-1.12, 1.12] as [number, number],
  y: [-1.12, 1.12] as [number, number],
};

export interface MemoryGlobeAnimationState {
  destroyed: boolean;
  documentHidden: boolean;
  reducedMotion: boolean;
  hoveredNode: boolean;
  pointerDown: boolean;
  nodeCount: number;
}

export function shouldAnimateMemoryGlobe(
  state: MemoryGlobeAnimationState,
): boolean {
  return (
    !state.destroyed &&
    !state.documentHidden &&
    !state.reducedMotion &&
    !state.hoveredNode &&
    !state.pointerDown &&
    state.nodeCount > 1
  );
}

const normalize = (point: Point3D): Point3D => {
  const length = Math.hypot(point.x, point.y, point.z) || 1;
  return {
    x: point.x / length,
    y: point.y / length,
    z: point.z / length,
  };
};

export function liftLayoutToSphere(model: MemoryGraphModel): void {
  const nodeIds = model
    .nodes()
    .filter((nodeId) => nodeId !== MEMORY_SCOPE_ROOT_ID);
  if (nodeIds.length === 0) return;

  const center = nodeIds.reduce(
    (result, nodeId) => ({
      x: result.x + model.getNodeAttribute(nodeId, "x") / nodeIds.length,
      y: result.y + model.getNodeAttribute(nodeId, "y") / nodeIds.length,
    }),
    { x: 0, y: 0 },
  );
  const radius = Math.max(
    ...nodeIds.map((nodeId) =>
      Math.hypot(
        model.getNodeAttribute(nodeId, "x") - center.x,
        model.getNodeAttribute(nodeId, "y") - center.y,
      ),
    ),
    Number.EPSILON,
  );

  nodeIds.forEach((nodeId, index) => {
    let horizontal = (model.getNodeAttribute(nodeId, "x") - center.x) / radius;
    let vertical = (model.getNodeAttribute(nodeId, "y") - center.y) / radius;
    if (nodeIds.length === 1) {
      horizontal = 0;
      vertical = 0;
    } else if (Math.hypot(horizontal, vertical) < Number.EPSILON) {
      const angle = (index / nodeIds.length) * Math.PI * 2;
      horizontal = Math.cos(angle) * 0.2;
      vertical = Math.sin(angle) * 0.2;
    }

    const squaredRadius = horizontal ** 2 + vertical ** 2;
    const divisor = squaredRadius + 1;
    const sphere = normalize({
      x: (2 * horizontal) / divisor,
      y: (2 * vertical) / divisor,
      z: (squaredRadius - 1) / divisor,
    });
    model.mergeNodeAttributes(nodeId, { sphere });
  });

  if (model.hasNode(MEMORY_SCOPE_ROOT_ID)) {
    model.mergeNodeAttributes(MEMORY_SCOPE_ROOT_ID, {
      x: 0,
      y: 0,
      depth: 0,
    });
  }
}

export function rotatePoint(
  point: Point3D,
  axis: Point3D,
  angle: number,
): Point3D {
  const normalizedAxis = normalize(axis);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const dot =
    normalizedAxis.x * point.x +
    normalizedAxis.y * point.y +
    normalizedAxis.z * point.z;
  return normalize({
    x:
      point.x * cosine +
      (normalizedAxis.y * point.z - normalizedAxis.z * point.y) * sine +
      normalizedAxis.x * dot * (1 - cosine),
    y:
      point.y * cosine +
      (normalizedAxis.z * point.x - normalizedAxis.x * point.z) * sine +
      normalizedAxis.y * dot * (1 - cosine),
    z:
      point.z * cosine +
      (normalizedAxis.x * point.y - normalizedAxis.y * point.x) * sine +
      normalizedAxis.z * dot * (1 - cosine),
  });
}

export function organicRotationAxis(
  elapsedSeconds: number,
  phases: Point3D,
): Point3D {
  return normalize({
    x: 0.55 + Math.sin(elapsedSeconds * 0.071 + phases.x) * 0.35,
    y: 0.7 + Math.sin(elapsedSeconds * 0.053 + phases.y) * 0.3,
    z: 0.35 + Math.sin(elapsedSeconds * 0.037 + phases.z) * 0.25,
  });
}

export function rotateMemoryGlobe(
  model: MemoryGraphModel,
  axis: Point3D,
  angle: number,
): void {
  model.forEachNode((nodeId, attributes) => {
    if (nodeId === MEMORY_SCOPE_ROOT_ID || !attributes.sphere) return;
    model.setNodeAttribute(
      nodeId,
      "sphere",
      rotatePoint(attributes.sphere, axis, angle),
    );
  });
}

export function projectMemoryGlobe(
  model: MemoryGraphModel,
  palette: MemoryGraphPalette,
): void {
  model.forEachNode((nodeId, attributes) => {
    if (nodeId === MEMORY_SCOPE_ROOT_ID) {
      model.mergeNodeAttributes(nodeId, {
        x: 0,
        y: 0,
        size: attributes.baseSize,
        label: attributes.baseLabel,
        color: nodeColor(palette, "scope"),
        depth: 0,
        zIndex: 200,
      });
      return;
    }
    if (!attributes.sphere) return;
    const depth = (attributes.sphere.z + 1) / 2;
    const opacity = 0.38 + depth * 0.62;
    model.mergeNodeAttributes(nodeId, {
      x: attributes.sphere.x,
      y: attributes.sphere.y,
      size: attributes.baseSize * (0.65 + depth * 0.5),
      label: attributes.sphere.z > -0.15 ? attributes.baseLabel : "",
      color: withColorAlpha(nodeColor(palette, attributes.colorRole), opacity),
      depth: attributes.sphere.z,
      zIndex: Math.round(depth * 100),
    });
  });

  model.forEachEdge((edgeId, attributes, source, target) => {
    const sourceDepth = model.getNodeAttribute(source, "depth") ?? 0;
    const targetDepth = model.getNodeAttribute(target, "depth") ?? 0;
    const depth = (sourceDepth + targetDepth + 2) / 4;
    model.mergeEdgeAttributes(edgeId, {
      color: withColorAlpha(
        edgeColor(palette, attributes.colorRole),
        0.28 + depth * 0.62,
      ),
      zIndex: Math.round(depth * 100),
    });
  });
}
