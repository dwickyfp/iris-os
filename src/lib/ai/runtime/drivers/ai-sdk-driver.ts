import { createToolLoopAgent } from "../../agent/create-tool-loop-agent";
import { BudgetGuard } from "../budget";
import type {
  DriverGenerateInput,
  DriverStreamInput,
  ExecutionDriver,
} from "../execution-driver";

export class AiSdkExecutionDriver implements ExecutionDriver {
  readonly id = "ai-sdk";

  generate({ agent, execution, orchestration }: DriverGenerateInput) {
    return createToolLoopAgent(
      orchestration.budget
        ? { ...agent, budget: new BudgetGuard(orchestration.budget) }
        : agent,
    ).generate(execution);
  }

  stream({ agent, execution, orchestration }: DriverStreamInput) {
    return createToolLoopAgent(
      orchestration.budget
        ? { ...agent, budget: new BudgetGuard(orchestration.budget) }
        : agent,
    ).stream(execution);
  }
}

export const aiSdkExecutionDriver = new AiSdkExecutionDriver();
