import type {
  MemoryConflict,
  MemoryEdge,
  MemoryEvidence,
  MemoryGraphView,
  MemoryNodeType,
  MemoryScope,
} from "app-types/memory";

export interface MemoryGraphAdapter {
  overview(userId: string, scope?: MemoryScope): Promise<MemoryGraphView>;
  neighbors(
    userId: string,
    nodeId: string,
    depth: number,
    scope?: MemoryScope,
  ): Promise<MemoryGraphView>;
  conflicts(userId: string, scope?: MemoryScope): Promise<MemoryConflict[]>;
  provenance(
    userId: string,
    nodeId: string,
    nodeType?: MemoryNodeType,
    scope?: MemoryScope,
  ): Promise<{ evidence: MemoryEvidence[]; history: unknown[] }>;
  resolveConflict(
    userId: string,
    edgeId: string,
    resolution: "source" | "target" | "both",
    scope?: MemoryScope,
  ): Promise<void>;
  connect(
    userId: string,
    edge: Omit<MemoryEdge, "id" | "userId">,
  ): Promise<void>;
}
