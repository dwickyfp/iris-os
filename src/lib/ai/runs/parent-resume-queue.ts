import PgBoss from "pg-boss";

export const PARENT_RESUME_QUEUE = "agent-parent-resume";
export const PARENT_RESUME_SWEEP_QUEUE = "agent-parent-resume-sweep";

let boss: PgBoss | undefined;

export async function enqueueParentResume(parentRunId: string) {
  if (!process.env.POSTGRES_URL) return false;
  boss ??= new PgBoss({ connectionString: process.env.POSTGRES_URL });
  await boss.start();
  await boss.createQueue(PARENT_RESUME_QUEUE);
  await boss.send(
    PARENT_RESUME_QUEUE,
    { parentRunId },
    {
      singletonKey: parentRunId,
      retryLimit: 5,
      retryDelay: 30,
      expireInHours: 1,
    },
  );
  return true;
}
