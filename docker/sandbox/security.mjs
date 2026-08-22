import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url).pathname;
const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
const workflow = readFileSync(
  new URL("../../.github/workflows/sandbox-gvisor.yml", import.meta.url),
  "utf8",
);
const runtimeDockerfile = readFileSync(
  new URL("./Dockerfile.runtime", import.meta.url),
  "utf8",
);

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function staticAssertions() {
  assert.match(packageJson.scripts["sandbox:smoke"], /compose\.linux-gvisor\.yml/);
  assert.match(packageJson.scripts["sandbox:smoke"], /sandbox-smoke/);
  assert.doesNotMatch(packageJson.scripts["sandbox:smoke"], /runc/);
  assert.equal(
    packageJson.scripts["sandbox:security"],
    "node docker/sandbox/security.mjs",
  );
  assert.match(workflow, /runs-on: \[self-hosted, Linux, gvisor\]/);
  assert.match(workflow, /pnpm sandbox:build/);
  assert.match(workflow, /pnpm sandbox:smoke/);
  assert.match(workflow, /pnpm sandbox:security/);
  assert.match(workflow, /anchore\/sbom-action@v0/);
  assert.match(workflow, /iris-sandbox-runtime\.cdx\.json/);
  assert.doesNotMatch(workflow, /apt-get|install.*runsc|runtime=runc|\|\|\s*true/);
  assert.match(runtimeDockerfile, /^FROM python:3\.12-slim-bookworm@sha256:[a-f0-9]{64}/m);
  assert.match(runtimeDockerfile, /requirements-runtime-\$\{TARGETARCH\}\.txt/);
  assert.match(runtimeDockerfile, /pip install --require-hashes --no-deps --only-binary=:all:/);
  assert.match(runtimeDockerfile, /USER sandbox[\s\S]*RUN python \/usr\/local\/bin\/runtime-smoke\.py/);
}

staticAssertions();

if (process.argv.includes("--static")) {
  console.log("sandbox security static assertions passed");
  process.exit(0);
}

assert.equal(process.platform, "linux", "sandbox security requires Linux");
assert.equal(
  docker(["info", "--format", "{{.OSType}}"]),
  "linux",
  "sandbox security requires a Linux Docker Engine",
);

const runtimes = JSON.parse(
  docker(["info", "--format", "{{json .Runtimes}}"]),
);
assert.ok(runtimes.runsc, "Docker runtime runsc is not registered");

const image = process.env.SANDBOX_RUNTIME_IMAGE ?? "iris-sandbox-runtime:local";
const containerId = docker([
  "create",
  "--runtime=runsc",
  "--network=none",
  "--read-only",
  "--user=10001:10001",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges:true",
  "--pids-limit=64",
  "--tmpfs=/tmp:size=64m,noexec,nosuid",
  "--tmpfs=/workspace:size=64m,noexec,nosuid",
  image,
  "python",
  "-c",
  [
    "import os, pathlib",
    "assert os.getuid() == 10001",
    "status = pathlib.Path('/proc/self/status').read_text()",
    "assert 'NoNewPrivs:\\t1' in status",
    "assert 'CapEff:\\t0000000000000000' in status",
    "try:",
    " pathlib.Path('/security-write-test').write_text('denied')",
    " raise AssertionError('root filesystem is writable')",
    "except OSError:",
    " pass",
  ].join("\n"),
]);

try {
  const inspect = JSON.parse(docker(["inspect", containerId]))[0];
  assert.equal(inspect.HostConfig.Runtime, "runsc");
  assert.equal(inspect.HostConfig.NetworkMode, "none");
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(inspect.HostConfig.CapDrop, ["ALL"]);
  assert.ok(
    inspect.HostConfig.SecurityOpt.includes("no-new-privileges:true"),
  );
  assert.equal(inspect.HostConfig.PidsLimit, 64);
  execFileSync("docker", ["start", "--attach", containerId], {
    cwd: root,
    stdio: "inherit",
  });
  const exitCode = Number(
    docker([
      "inspect",
      "--format",
      "{{.State.ExitCode}}",
      containerId,
    ]),
  );
  assert.equal(exitCode, 0, "runsc security assertion container failed");
} finally {
  execFileSync("docker", ["rm", "--force", containerId], {
    cwd: root,
    stdio: "ignore",
  });
}

console.log("sandbox security static and runsc assertions passed");
