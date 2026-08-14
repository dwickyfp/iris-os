import "load-env";
import PgBoss from "pg-boss";
import { registerActivityWorkers } from "./workers/activity-worker";
import { registerAutomationWorkers } from "./workers/automation-worker";
import { registerDelegationWorkers } from "./workers/delegation-worker";
import { registerLearningWorkers } from "./workers/learning-worker";
import { isV2FeatureEnabled } from "lib/feature-flags";

const connectionString = process.env.POSTGRES_URL;
if (!connectionString) throw new Error("POSTGRES_URL is required");

const boss = new PgBoss({ connectionString });
await boss.start();
if (isV2FeatureEnabled("learning")) {
  await registerActivityWorkers(boss);
  await registerLearningWorkers(boss);
}
if (isV2FeatureEnabled("automation")) await registerAutomationWorkers(boss);
if (isV2FeatureEnabled("delegation")) await registerDelegationWorkers(boss);

const shutdown = async () => {
  await boss.stop({ graceful: true, timeout: 30_000 });
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
