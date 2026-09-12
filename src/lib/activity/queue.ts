import { getStartedPgBoss } from "lib/jobs/pg-boss";

export const ACTIVITY_PROCESS_QUEUE = "iris-activity-process";
export const ACTIVITY_SWEEP_QUEUE = "iris-activity-sweep";

export async function enqueueActivityEvent(eventId: string) {
  const queue = await getStartedPgBoss();
  if (!queue) return;
  await queue.createQueue(ACTIVITY_PROCESS_QUEUE);
  await queue.send(
    ACTIVITY_PROCESS_QUEUE,
    { eventId },
    {
      singletonKey: eventId,
      retryLimit: 5,
      retryDelay: 30,
      expireInHours: 23,
    },
  );
}
