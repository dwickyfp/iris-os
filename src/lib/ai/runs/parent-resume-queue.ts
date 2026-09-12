import { getStartedPgBoss } from "lib/jobs/pg-boss";

export const PARENT_RESUME_QUEUE = "agent-parent-resume";
export const PARENT_RESUME_SWEEP_QUEUE = "agent-parent-resume-sweep";

export async function enqueueParentResume(parentRunId: string) {
  const boss = await getStartedPgBoss();
  if (!boss) return false;
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
