import { getStartedPgBoss } from "lib/jobs/pg-boss";

export const LEARNING_PROMOTION_QUEUE = "learning-promotion";
export const LEARNING_PROMOTION_SWEEP_QUEUE = "learning-promotion-sweep";

export async function enqueueLearningPromotion(candidateId: string) {
  const queue = await getStartedPgBoss();
  if (!queue) return;
  await queue.createQueue(LEARNING_PROMOTION_QUEUE);
  await queue.send(
    LEARNING_PROMOTION_QUEUE,
    { candidateId },
    {
      singletonKey: candidateId,
      retryLimit: 5,
      retryDelay: 30,
      expireInHours: 23,
    },
  );
}
