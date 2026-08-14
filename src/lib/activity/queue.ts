import PgBoss from "pg-boss";

export const ACTIVITY_PROCESS_QUEUE = "iris-activity-process";
export const ACTIVITY_SWEEP_QUEUE = "iris-activity-sweep";

let boss: PgBoss | undefined;

function getBoss() {
  if (!process.env.POSTGRES_URL) return undefined;
  boss ??= new PgBoss({ connectionString: process.env.POSTGRES_URL });
  return boss;
}

export async function enqueueActivityEvent(eventId: string) {
  const queue = getBoss();
  if (!queue) return;
  await queue.start();
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
