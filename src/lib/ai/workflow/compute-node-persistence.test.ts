import { describe, expect, it } from "vitest";
import { createUINode } from "./create-ui-node";
import {
  convertDBNodeToUINode,
  convertUINodeToDBNode,
} from "./shared.workflow";
import {
  NodeKind,
  type ComputeNodeData,
  type UINode,
} from "./workflow.interface";

describe("compute node persistence", () => {
  it("round trips code, bindings, timeout, and expected output schema", () => {
    const node = createUINode(NodeKind.Compute, {
      id: "compute-1",
    }) as UINode<NodeKind.Compute>;
    node.data.code = 'output = {"answer": inputs["question"]}';
    node.data.inputBindings = [
      {
        name: "question",
        source: { nodeId: "input-1", path: ["question"] },
        schema: { type: "string" },
      },
    ];
    node.data.timeoutMs = 5000;
    node.data.outputSchema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };

    const persisted = convertUINodeToDBNode("workflow-1", node);
    const restored = convertDBNodeToUINode({
      ...persisted,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const restoredData = restored.data as ComputeNodeData;
    expect(restoredData).toMatchObject({
      kind: NodeKind.Compute,
      language: "python",
      code: node.data.code,
      inputBindings: node.data.inputBindings,
      timeoutMs: 5000,
      outputSchema: node.data.outputSchema,
    });
  });
});
