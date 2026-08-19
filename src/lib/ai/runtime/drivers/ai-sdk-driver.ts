import { createToolLoopAgent } from "../../agent/create-tool-loop-agent";
import type {
  DriverGenerateInput,
  DriverStreamInput,
  ExecutionDriver,
} from "../execution-driver";

export class AiSdkExecutionDriver implements ExecutionDriver {
  readonly id = "ai-sdk";

  generate({ agent, execution }: DriverGenerateInput) {
    return createToolLoopAgent(agent).generate(execution);
  }

  stream({ agent, execution }: DriverStreamInput) {
    return createToolLoopAgent(agent).stream(execution);
  }
}

export const aiSdkExecutionDriver = new AiSdkExecutionDriver();
