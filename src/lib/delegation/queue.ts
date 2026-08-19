import { randomUUID } from "node:crypto";
import PgBoss from "pg-boss";

export const DELEGATION_EXECUTE_QUEUE = "delegation-execute";
export const DELEGATION_SWEEP_QUEUE = "delegation-sweep";
export const DELEGATION_REMOTE_CANCEL_QUEUE = "delegation-remote-cancel";

let boss: PgBoss | undefined;
function getBoss() {
  if (!process.env.POSTGRES_URL) return undefined;
  boss ??= new PgBoss({ connectionString: process.env.POSTGRES_URL });
  return boss;
}

export async function enqueueRemoteCancellation(childRunId: string) {
  const queue = getBoss();
  if (!queue) return false;
  await queue.start();
  await queue.createQueue(DELEGATION_REMOTE_CANCEL_QUEUE);
  await queue.send(
    DELEGATION_REMOTE_CANCEL_QUEUE,
    { childRunId },
    {
      singletonKey: childRunId,
      retryLimit: 3,
      retryDelay: 30,
      expireInHours: 1,
    },
  );
  return true;
}

export async function enqueueDelegatedRun(
  childRunId: string,
  delaySeconds = 0,
) {
  const queue = getBoss();
  if (!queue) return false;
  await queue.start();
  await queue.createQueue(DELEGATION_EXECUTE_QUEUE);
  await queue.send(
    DELEGATION_EXECUTE_QUEUE,
    { childRunId },
    {
      // The active singleton schedules its own delayed successor.
      singletonKey:
        delaySeconds > 0 ? `${childRunId}:recheck:${randomUUID()}` : childRunId,
      retryLimit: 3,
      retryDelay: 30,
      expireInHours: 1,
      ...(delaySeconds > 0 ? { startAfter: delaySeconds } : {}),
    },
  );
  return true;
}
