import { getStartedPgBoss } from "lib/jobs/pg-boss";

export const AUTOMATION_EXECUTE_QUEUE = "automation-execute";
export const AUTOMATION_REFRESH_QUEUE = "automation-refresh";

export async function enqueueAutomationRefresh(automationId: string) {
  const queue = await getStartedPgBoss();
  if (!queue) return;
  await queue.createQueue(AUTOMATION_REFRESH_QUEUE);
  await queue.send(
    AUTOMATION_REFRESH_QUEUE,
    { automationId },
    {
      singletonKey: automationId,
    },
  );
}

export async function enqueueAutomationRun(runId: string, delaySeconds = 0) {
  const queue = await getStartedPgBoss();
  if (!queue) return;
  await queue.createQueue(AUTOMATION_EXECUTE_QUEUE);
  await queue.send(
    AUTOMATION_EXECUTE_QUEUE,
    { runId },
    {
      singletonKey: `${runId}:${delaySeconds}`,
      retryLimit: 5,
      retryDelay: 30,
      expireInHours: 23,
      ...(delaySeconds > 0 ? { startAfter: delaySeconds } : {}),
    },
  );
}
