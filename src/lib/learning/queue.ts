import PgBoss from "pg-boss";

export const LEARNING_PROMOTION_QUEUE = "learning-promotion";
export const LEARNING_PROMOTION_SWEEP_QUEUE = "learning-promotion-sweep";

let boss: PgBoss | undefined;

function getBoss() {
  if (!process.env.POSTGRES_URL) return undefined;
  boss ??= new PgBoss({ connectionString: process.env.POSTGRES_URL });
  return boss;
}

export async function enqueueLearningPromotion(candidateId: string) {
  const queue = getBoss();
  if (!queue) return;
  await queue.start();
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
