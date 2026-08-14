import "load-env";
import PgBoss from "pg-boss";
import { registerActivityWorkers } from "./workers/activity-worker";
import { registerAutomationWorkers } from "./workers/automation-worker";
import { registerDelegationWorkers } from "./workers/delegation-worker";

const connectionString = process.env.POSTGRES_URL;
if (!connectionString) throw new Error("POSTGRES_URL is required");

const boss = new PgBoss({ connectionString });
await boss.start();
await registerActivityWorkers(boss);
await registerAutomationWorkers(boss);
await registerDelegationWorkers(boss);

const shutdown = async () => {
  await boss.stop({ graceful: true, timeout: 30_000 });
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
