import { getSession } from "auth/server";
import { ContextPlanner } from "lib/ai/context-planner";
import {
  chatRepository,
  taskRepository,
  workspaceRepository,
} from "lib/db/repository";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (process.env.NODE_ENV === "production")
    return Response.json({ error: "Not found" }, { status: 404 });
  const threadId = new URL(request.url).searchParams.get("threadId");
  if (!threadId)
    return Response.json({ error: "threadId is required" }, { status: 400 });
  const thread = await chatRepository.selectThreadDetails(threadId);
  if (!thread || thread.userId !== session.user.id)
    return Response.json({ error: "Thread not found" }, { status: 404 });
  const [workspace, task] = await Promise.all([
    thread.workspaceId
      ? workspaceRepository.selectById(thread.workspaceId, session.user.id)
      : null,
    thread.taskId
      ? taskRepository.select(thread.taskId, session.user.id)
      : null,
  ]);
  const plan = new ContextPlanner().plan({
    currentRequest: "[current request supplied at runtime]",
    task: task ? `[task:${task.id}]` : undefined,
    workspaceInstructions: workspace
      ? `[workspace:${workspace.id}]`
      : undefined,
    agentAndSkills: "[resolved per request]",
    memories: "[exact scopes resolved per request]",
    resources: task ? `[task resources:${task.id}]` : undefined,
    conversation: `[thread:${thread.id}]`,
  });
  return Response.json({
    threadId: thread.id,
    workspaceId: workspace?.id ?? null,
    taskId: task?.id ?? null,
    sections: plan.sections.map((section) => ({
      source: section.source,
      trusted: section.trusted,
      estimatedTokens: section.estimatedTokens,
      reference: section.content,
    })),
    truncated: plan.truncated,
  });
}
