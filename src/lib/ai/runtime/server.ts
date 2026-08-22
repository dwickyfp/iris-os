import "server-only";

import { runManager } from "../runs/server";
import { AiSdkExecutionDriver } from "./drivers/ai-sdk-driver";
import { IrisHarness } from "./harness";
import { eventRecorder } from "./event-recorder.server";
import { serverBudgetAuthority } from "./server-budget-authority";

const aiSdkExecutionDriver = new AiSdkExecutionDriver(serverBudgetAuthority);

export const irisHarness = new IrisHarness(
  aiSdkExecutionDriver,
  runManager,
  [],
  eventRecorder,
);
