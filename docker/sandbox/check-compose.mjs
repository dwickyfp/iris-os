import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url).pathname;
const baseFiles = ["docker/compose.yml", "docker/sandbox/compose.yml"];
const overlayFiles = [
  ...baseFiles,
  "docker/sandbox/compose.linux-gvisor.yml",
];
const scripts = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url)))
  .scripts;

assert.match(scripts["sandbox:build"], /SANDBOX_RUNNER_TOKEN=[^ ]+/);
for (const command of [scripts["sandbox:up"], scripts["sandbox:smoke"]]) {
  assert.doesNotMatch(command, /SANDBOX_RUNNER_TOKEN=/);
}

function composeConfig(files) {
  const args = files.flatMap((file) => ["--file", file]);
  const output = execFileSync(
    "docker",
    ["compose", ...args, "--profile", "smoke", "config", "--format", "json"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        SANDBOX_RUNNER_TOKEN: "sandbox-compose-check-token-32-characters",
        SANDBOX_RUNNER_IMAGE: `iris-sandbox-runtime@sha256:${"a".repeat(64)}`,
      },
    },
  );
  return JSON.parse(output);
}

function composeWithoutTokenFails(files) {
  const args = files.flatMap((file) => ["--file", file]);
  const { SANDBOX_RUNNER_TOKEN: _token, ...env } = process.env;
  assert.throws(
    () =>
      execFileSync("docker", ["compose", ...args, "config"], {
        cwd: root,
        encoding: "utf8",
        env,
        stdio: "pipe",
      }),
    (error) =>
      String(error.stderr).includes("high-entropy SANDBOX_RUNNER_TOKEN"),
  );
}

function socketServices(config) {
  return Object.entries(config.services)
    .filter(([, service]) =>
      (service.volumes ?? []).some(
        (volume) =>
          volume.source === "/var/run/docker.sock" ||
          volume.target === "/var/run/docker.sock",
      ),
    )
    .map(([name]) => name)
    .sort();
}

const base = composeConfig(baseFiles);
composeWithoutTokenFails(baseFiles);
assert.deepEqual(socketServices(base), []);
assert.equal(base.services["sandbox-smoke"].runtime, "runsc");
assert.equal(base.services["sandbox-smoke"].network_mode, "none");
assert.equal(base.services["sandbox-package-broker"].read_only, true);

const overlay = composeConfig(overlayFiles);
assert.deepEqual(socketServices(overlay), ["sandbox-runner"]);
for (const service of ["iris-os", "iris-worker", "memory-worker"]) {
  assert.equal(socketServices({ services: { [service]: overlay.services[service] } }).length, 0);
}

console.log("sandbox Compose security invariants passed");
