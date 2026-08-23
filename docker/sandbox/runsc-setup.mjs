import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const composeFile = "docker/sandbox/docker-compose.yml";
const composeService = "runner";
const runtimeImage = "iris-sandbox-runtime:local";
const daemonConfigPath = "/etc/docker/daemon.json";
const candidateRunscPaths = [
  "/usr/local/bin/runsc",
  "/usr/bin/runsc",
];

function command(name, args, options = {}) {
  return execFileSync(name, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 120_000,
    ...options,
  }).trim();
}

function dockerInfo() {
  return JSON.parse(command("docker", ["info", "--format", "{{json .}}"]));
}

function requireLinux() {
  if (process.platform !== "linux") {
    throw new Error(
      "runsc requires a native Linux Docker Engine; configure this on the Linux runner host",
    );
  }
}

function requireRoot() {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new Error("run configure with sudo: sudo node docker/sandbox/runsc-setup.mjs configure");
  }
}

function findRunsc() {
  const explicit = process.env.RUNSC_PATH;
  const candidates = explicit ? [explicit] : candidateRunscPaths;
  for (const candidate of candidates) {
    try {
      const version = command(candidate, ["--version"]);
      console.log(`Found ${candidate}: ${version}`);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    [
      "runsc binary was not found.",
      "Install gVisor first (Debian/Ubuntu example):",
      "  sudo apt-get update && sudo apt-get install -y apt-transport-https ca-certificates curl gnupg",
      "  curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg",
      '  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list > /dev/null',
      "  sudo apt-get update && sudo apt-get install -y runsc",
      "Then rerun this command.",
    ].join("\n"),
  );
}

export function mergeRuntimeConfig(currentJson, runscPath) {
  const current = currentJson.trim() ? JSON.parse(currentJson) : {};
  return JSON.stringify(
    {
      ...current,
      runtimes: {
        ...current.runtimes,
        runsc: { path: runscPath },
      },
    },
    null,
    2,
  ) + "\n";
}

function restartDocker() {
  if (existsSync("/bin/systemctl") || existsSync("/usr/bin/systemctl")) {
    command("systemctl", ["restart", "docker"], { stdio: "inherit" });
    return;
  }
  command("service", ["docker", "restart"], { stdio: "inherit" });
}

function waitForDocker() {
  let lastError;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      dockerInfo();
      return;
    } catch (error) {
      lastError = error;
    }
    command("sleep", ["1"]);
  }
  throw new Error(`Docker did not become available after restart: ${lastError}`);
}

function verifyRunscRegistration() {
  const runtimes = dockerInfo().Runtimes ?? {};
  if (!Object.hasOwn(runtimes, "runsc")) {
    throw new Error("Docker does not expose the registered runsc runtime");
  }
  console.log("Docker runtime registration verified:", Object.keys(runtimes).sort());
}

function pinRuntimeImageId() {
  const imageId = command("docker", [
    "image",
    "inspect",
    runtimeImage,
    "--format",
    "{{.Id}}",
  ]);
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
    throw new Error(`Invalid immutable runtime image ID: ${imageId}`);
  }
  const composePath = resolve(root, composeFile);
  const contents = readFileSync(composePath, "utf8");
  const updated = contents.replace(
    /^(\s*SANDBOX_RUNNER_IMAGE:\s*)sha256:[a-f0-9]{64}\s*$/m,
    `$1${imageId}`,
  );
  if (updated === contents) {
    throw new Error("Could not update SANDBOX_RUNNER_IMAGE in standalone Compose");
  }
  const temporary = join(tmpdir(), `iris-sandbox-compose-${process.pid}`);
  writeFileSync(temporary, updated);
  renameSync(temporary, composePath);
  console.log(`Pinned ${runtimeImage} to ${imageId}`);
}

function recreateRunner() {
  verifyRunscRegistration();
  pinRuntimeImageId();
  command(
    "docker",
    [
      "compose",
      "-f",
      composeFile,
      "up",
      "-d",
      "--force-recreate",
      "--no-build",
      composeService,
      "package-broker",
    ],
    { stdio: "inherit" },
  );
  console.log("Sandbox runner recreated; check readiness with pnpm sandbox:standalone:ps");
}

function configure() {
  requireLinux();
  requireRoot();
  const info = dockerInfo();
  if (info.OSType !== "linux") {
    throw new Error(`Docker Server OSType must be linux, received ${info.OSType}`);
  }
  const runscPath = findRunsc();
  const current = existsSync(daemonConfigPath)
    ? readFileSync(daemonConfigPath, "utf8")
    : "";
  const updated = mergeRuntimeConfig(current, runscPath);
  JSON.parse(updated);
  if (current) {
    const backup = `${daemonConfigPath}.backup-${Date.now()}`;
    writeFileSync(backup, current);
    console.log(`Backed up Docker daemon config to ${backup}`);
  }
  const temporary = join(tmpdir(), `docker-daemon-${process.pid}.json`);
  writeFileSync(temporary, updated);
  renameSync(temporary, daemonConfigPath);
  restartDocker();
  waitForDocker();
  verifyRunscRegistration();
  console.log("runsc is registered with Docker.");
}

const action = process.argv[2];
try {
  if (action === "check") {
    requireLinux();
    verifyRunscRegistration();
  } else if (action === "configure") {
    configure();
  } else if (action === "recreate") {
    requireLinux();
    verifyRunscRegistration();
    recreateRunner();
  } else {
    throw new Error("usage: runsc-setup.mjs <check|configure|recreate>");
  }
} catch (error) {
  console.error(`sandbox runsc setup failed: ${error.message}`);
  process.exitCode = 1;
}
