import "load-env";
import { hostname } from "node:os";
import packageJson from "../package.json" with { type: "json" };
import PgBoss from "pg-boss";
import { registerActivityWorkers } from "./workers/activity-worker";
import { registerAutomationWorkers } from "./workers/automation-worker";
import { registerDelegationWorkers } from "./workers/delegation-worker";
import { registerLearningWorkers } from "./workers/learning-worker";
import { registerParentResumeWorkers } from "./workers/parent-resume-worker";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { parseOperationsConfig } from "lib/operations/config";
import { startWorkerHeartbeat } from "lib/operations/heartbeat";
import { sandboxServerConfig } from "lib/sandbox/config.server";
import { sandboxManager } from "lib/sandbox/server";

const config = parseOperationsConfig(process.env);
const workerId =
  config.IRIS_WORKER_ID ??
  `${hostname()}:${process.pid}:${crypto.randomUUID()}`;

const boss = new PgBoss({ connectionString: config.POSTGRES_URL });
await boss.start();
if (isV2FeatureEnabled("learning")) {
  await registerActivityWorkers(boss);
  await registerLearningWorkers(boss);
}
if (isV2FeatureEnabled("automation")) await registerAutomationWorkers(boss);
if (isV2FeatureEnabled("delegation")) {
  await registerDelegationWorkers(boss);
  await registerParentResumeWorkers(boss);
}
const sandboxConfig = sandboxServerConfig();
const sandboxReaper = setInterval(
  () =>
    void (
      sandboxConfig.enabled
        ? sandboxManager.reap()
        : sandboxManager.reapArtifactCleanup()
    ).catch((error) => console.error("sandbox reaper failed", error)),
  30_000,
);
sandboxReaper?.unref();

let shuttingDown = false;
const heartbeat = startWorkerHeartbeat(
  config.POSTGRES_URL,
  {
    workerId,
    hostname: hostname(),
    pid: process.pid,
    version: packageJson.version,
  },
  config.IRIS_WORKER_HEARTBEAT_INTERVAL_MS,
  {
    maxConsecutiveFailures:
      config.IRIS_WORKER_MAX_CONSECUTIVE_HEARTBEAT_FAILURES,
    onShutdown: async (error) => {
      console.error(
        "iris-worker heartbeat failure threshold reached; shutting down",
        error,
      );
      await shutdown(1);
    },
  },
);

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (sandboxReaper) clearInterval(sandboxReaper);
  const forcedExit = setTimeout(() => {
    console.error("iris-worker graceful shutdown timed out");
    process.exit(1);
  }, 40_000);
  forcedExit.unref();
  try {
    await heartbeat.stop();
  } catch (error) {
    console.error("iris-worker heartbeat shutdown failed", error);
    exitCode = 1;
  }
  try {
    await boss.stop({ graceful: true, timeout: 30_000 });
  } catch (error) {
    console.error("iris-worker queue shutdown failed", error);
    exitCode = 1;
  } finally {
    clearTimeout(forcedExit);
    process.exit(exitCode);
  }
}

await heartbeat.start();

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
