import PgBoss from "pg-boss";

export const AUTOMATION_EXECUTE_QUEUE = "automation-execute";
export const AUTOMATION_REFRESH_QUEUE = "automation-refresh";

let boss: PgBoss | undefined;
function getBoss() {
  if (!process.env.POSTGRES_URL) return undefined;
  boss ??= new PgBoss({ connectionString: process.env.POSTGRES_URL });
  return boss;
}

export async function enqueueAutomationRefresh(automationId: string) {
  const queue = getBoss();
  if (!queue) return;
  await queue.start();
  await queue.createQueue(AUTOMATION_REFRESH_QUEUE);
  await queue.send(
    AUTOMATION_REFRESH_QUEUE,
    { automationId },
    {
      singletonKey: automationId,
    },
  );
}

export async function enqueueAutomationRun(input: {
  automationId: string;
  scheduledFor: string;
  approvalGranted?: boolean;
}) {
  const queue = getBoss();
  if (!queue) return;
  await queue.start();
  await queue.createQueue(AUTOMATION_EXECUTE_QUEUE);
  await queue.send(AUTOMATION_EXECUTE_QUEUE, input, {
    singletonKey: `${input.automationId}:${input.scheduledFor}`,
    retryLimit: 5,
    retryDelay: 30,
    expireInHours: 23,
  });
}
