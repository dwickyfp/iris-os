import "load-env";
import {
  SandboxRunner,
  createSandboxRunnerServer,
  parseSandboxRunnerConfig,
} from "../src/lib/sandbox-runner";

const config = parseSandboxRunnerConfig(process.env);
const runner = new SandboxRunner(config);
const server = createSandboxRunnerServer(runner);

try {
  await runner.start();
} catch (error) {
  console.error("sandbox runner startup failed", error);
  process.exit(1);
}

server.listen(config.SANDBOX_RUNNER_PORT, config.SANDBOX_RUNNER_HOST, () => {
  console.log(
    `sandbox runner listening on ${config.SANDBOX_RUNNER_HOST}:${config.SANDBOX_RUNNER_PORT}`,
  );
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await runner.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
