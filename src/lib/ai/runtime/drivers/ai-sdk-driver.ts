import { createToolLoopAgent } from "../../agent/create-tool-loop-agent";
import { BudgetGuard } from "../budget";
import type {
  DriverGenerateInput,
  DriverStreamInput,
  ExecutionDriver,
} from "../execution-driver";

export type DurableBudgetCharger = {
  charge(
    runId: string,
    token: string,
    kind: "steps" | "tokens" | "tool_calls",
    amount: number,
  ): Promise<unknown>;
};

function guardedAgent(
  { agent, orchestration }: DriverGenerateInput,
  durableBudget?: DurableBudgetCharger,
) {
  if (!orchestration.budget) return agent;
  if (!durableBudget) throw new Error("DURABLE_BUDGET_AUTHORITY_REQUIRED");
  const runId = orchestration.identity.runId;
  const executionId = orchestration.identity.requestId;
  return {
    ...agent,
    budget: new BudgetGuard(orchestration.budget),
    durableBudget: {
      charge: (
        token: string,
        kind: "steps" | "tokens" | "tool_calls",
        amount: number,
      ) =>
        durableBudget.charge(
          runId,
          `${runId}:${executionId}:${token}`,
          kind,
          amount,
        ),
    },
  };
}

export class AiSdkExecutionDriver implements ExecutionDriver {
  readonly id = "ai-sdk";

  constructor(private readonly durableBudget?: DurableBudgetCharger) {}

  generate({ agent, execution, orchestration }: DriverGenerateInput) {
    return createToolLoopAgent(
      guardedAgent({ agent, execution, orchestration }, this.durableBudget),
    ).generate(execution);
  }

  stream({ agent, execution, orchestration }: DriverStreamInput) {
    return createToolLoopAgent(
      guardedAgent({ agent, execution, orchestration }, this.durableBudget),
    ).stream(execution);
  }
}

export const aiSdkExecutionDriver = new AiSdkExecutionDriver();
