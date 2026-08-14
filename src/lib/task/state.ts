import type { TaskStatus } from "app-types/task";

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  planned: ["in_progress", "cancelled"],
  in_progress: ["blocked", "completed", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  completed: [],
  cancelled: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus) {
  return from === to || transitions[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus) {
  if (!canTransitionTask(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}
