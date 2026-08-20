import "server-only";

import { contextEngine } from "lib/ai/context-compaction";
import {
  RunPreparer,
  type RunPreparationDependencies,
} from "./run-preparer";

/** Canonical server factory for chat, automation, delegation, and resume preparation. */
export function serverRunPreparer<Capabilities = unknown, Model = unknown>(
  dependencies: RunPreparationDependencies<Capabilities, Model> = {},
) {
  return new RunPreparer(contextEngine, dependencies);
}
