"use client";

import { useReactFlow } from "@xyflow/react";
import {
  ComputeNodeData,
  OutputSchemaSourceKey,
  UINode,
} from "lib/ai/workflow/workflow.interface";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { Textarea } from "ui/textarea";
import { PlusIcon, TrashIcon, VariableIcon } from "lucide-react";
import { VariableSelect } from "../variable-select";
import { VariableMentionItem } from "../variable-mention-item";
import { findAvailableSchemaBySource } from "lib/ai/workflow/shared.workflow";
import { OutputSchemaEditor } from "../output-schema-editor";
import { useState } from "react";

export function ComputeNodeConfig({ node }: { node: UINode }) {
  const data = node.data as ComputeNodeData;
  const [schemaOpen, setSchemaOpen] = useState(false);
  const { updateNodeData, getNodes, getEdges } = useReactFlow<UINode>();
  const update = (value: Partial<ComputeNodeData>) =>
    updateNodeData(node.id, value);

  const addBinding = (item: {
    nodeId: string;
    path: string[];
    type: string;
  }) => {
    const baseName = item.path.at(-1) ?? "input";
    let name = baseName;
    let suffix = 2;
    while (data.inputBindings.some((binding) => binding.name === name))
      name = `${baseName}_${suffix++}`;
    update({
      inputBindings: [
        ...data.inputBindings,
        {
          name,
          source: { nodeId: item.nodeId, path: item.path },
          schema: { type: item.type as any },
        },
      ],
    });
  };

  return (
    <div className="space-y-5 px-4">
      <div className="space-y-2">
        <Label>Language</Label>
        <Input value="Python" disabled />
      </div>
      <div className="space-y-2">
        <Label htmlFor="compute-code">Code</Label>
        <Textarea
          id="compute-code"
          className="min-h-56 font-mono text-xs"
          value={data.code}
          onChange={(event) => update({ code: event.target.value })}
          placeholder={'output = {"result": inputs["value"]}'}
        />
        <p className="text-xs text-muted-foreground">
          Read values from <code>inputs</code> and assign JSON-compatible data
          to
          <code> output</code>.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="compute-timeout">Timeout (ms)</Label>
        <Input
          id="compute-timeout"
          type="number"
          min={1000}
          max={60000}
          step={1000}
          value={data.timeoutMs}
          onChange={(event) =>
            update({ timeoutMs: Number(event.target.value) })
          }
        />
      </div>
      <div className="space-y-2">
        <Label>Input bindings</Label>
        {data.inputBindings.map((binding, index) => (
          <div key={`${binding.name}-${index}`} className="space-y-1">
            <div className="flex items-center gap-2">
              <Input
                aria-label="Binding name"
                value={binding.name}
                onChange={(event) => {
                  const inputBindings = [...data.inputBindings];
                  inputBindings[index] = {
                    ...binding,
                    name: event.target.value,
                  };
                  update({ inputBindings });
                }}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() =>
                  update({
                    inputBindings: data.inputBindings.filter(
                      (_, bindingIndex) => bindingIndex !== index,
                    ),
                  })
                }
              >
                <TrashIcon />
              </Button>
            </div>
            <VariableMentionItem
              {...findAvailableSchemaBySource({
                nodeId: data.id,
                source: binding.source as OutputSchemaSourceKey,
                nodes: getNodes().map(({ data }) => data),
                edges: getEdges(),
              })}
            />
          </div>
        ))}
        <VariableSelect currentNodeId={data.id} onChange={addBinding}>
          <Button type="button" variant="outline" className="w-full">
            <PlusIcon />
            <VariableIcon /> Add binding
          </Button>
        </VariableSelect>
      </div>
      <OutputSchemaEditor
        open={schemaOpen}
        onOpenChange={setSchemaOpen}
        schema={data.outputSchema}
        onChange={(outputSchema) => update({ outputSchema })}
      >
        <Button type="button" variant="outline" className="w-full">
          Edit expected output schema
        </Button>
      </OutputSchemaEditor>
    </div>
  );
}
