import PgBoss from "pg-boss";

export const DELEGATION_EXECUTE_QUEUE = "delegation-execute";
export const DELEGATION_SWEEP_QUEUE = "delegation-sweep";

let boss: PgBoss | undefined;
function getBoss() {
  if (!process.env.POSTGRES_URL) return undefined;
  boss ??= new PgBoss({ connectionString: process.env.POSTGRES_URL });
  return boss;
}

export async function enqueueDelegatedRun(
  childRunId: string,
  delaySeconds = 0,
) {
  const queue = getBoss();
  if (!queue) return;
  await queue.start();
  await queue.createQueue(DELEGATION_EXECUTE_QUEUE);
  await queue.send(
    DELEGATION_EXECUTE_QUEUE,
    { childRunId },
    {
      singletonKey: `${childRunId}:${delaySeconds}`,
      retryLimit: 3,
      retryDelay: 30,
      expireInHours: 1,
      ...(delaySeconds > 0 ? { startAfter: delaySeconds } : {}),
    },
  );
}
