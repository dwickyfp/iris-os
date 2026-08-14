import type {
  MemoryConflict,
  MemoryEdge,
  MemoryEvidence,
  MemoryGraphView,
  MemoryNodeType,
} from "app-types/memory";

export interface MemoryGraphAdapter {
  overview(userId: string): Promise<MemoryGraphView>;
  neighbors(
    userId: string,
    nodeId: string,
    depth: number,
  ): Promise<MemoryGraphView>;
  conflicts(userId: string): Promise<MemoryConflict[]>;
  provenance(
    userId: string,
    nodeId: string,
    nodeType?: MemoryNodeType,
  ): Promise<{ evidence: MemoryEvidence[]; history: unknown[] }>;
  resolveConflict(
    userId: string,
    edgeId: string,
    resolution: "source" | "target" | "both",
  ): Promise<void>;
  connect(
    userId: string,
    edge: Omit<MemoryEdge, "id" | "userId">,
  ): Promise<void>;
}
