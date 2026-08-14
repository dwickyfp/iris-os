import { TaskOperations } from "@/components/os/task-operations";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { notFound } from "next/navigation";

export default function TasksPage() {
  if (!isV2FeatureEnabled("workspaces")) notFound();
  return <TaskOperations />;
}
