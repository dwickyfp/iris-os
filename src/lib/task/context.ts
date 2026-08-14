import type { IrisTask } from "app-types/task";

export function buildTaskContextPrompt(task?: IrisTask | null) {
  if (!task) return "";
  return `Active task ledger (trusted application state):
Title: ${task.title}
Status: ${task.status}
Priority: ${task.priority}
Next action: ${task.nextAction ?? "Not set"}
Checkpoint: ${task.checkpoint ?? "No checkpoint yet"}

Use this ledger to continue the work. The current user request takes precedence. Do not claim a checkpoint action is complete unless the current run actually completes it.`;
}
