import "server-only";

import { runManager } from "../runs/server";
import { aiSdkExecutionDriver } from "./drivers/ai-sdk-driver";
import { IrisHarness } from "./harness";
import { eventRecorder } from "./event-recorder.server";

export const irisHarness = new IrisHarness(
  aiSdkExecutionDriver,
  runManager,
  [],
  eventRecorder,
);
