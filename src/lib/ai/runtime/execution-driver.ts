import type { createToolLoopAgent } from "../agent/create-tool-loop-agent";
import type { ToolLoopAgentConfig } from "../agent/create-tool-loop-agent";
import type { HarnessOrchestration } from "./contracts";

type NativeToolLoopAgent = ReturnType<typeof createToolLoopAgent>;

export type DriverGenerateInput = {
  agent: ToolLoopAgentConfig;
  execution: Parameters<NativeToolLoopAgent["generate"]>[0];
  orchestration?: HarnessOrchestration;
};

export type DriverStreamInput = {
  agent: ToolLoopAgentConfig;
  execution: Parameters<NativeToolLoopAgent["stream"]>[0];
  orchestration?: HarnessOrchestration;
};

export interface ExecutionDriver {
  readonly id: string;

  generate(
    input: DriverGenerateInput,
  ): ReturnType<NativeToolLoopAgent["generate"]>;

  stream(input: DriverStreamInput): ReturnType<NativeToolLoopAgent["stream"]>;
}
