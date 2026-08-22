import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import tar from "tar-stream";

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
const compose = readFileSync(new URL("./compose.yml", import.meta.url), "utf8");
const runId =
  process.env.SANDBOX_SECURITY_RUN_ID ??
  `iris-security-${randomBytes(8).toString("hex")}`;
const cleanupContainers = new Set();
const cleanupNetworks = new Set();
const cleanupSessions = new Set();
const evidenceUrl = new URL(
  "../../sandbox-security-evidence.json",
  import.meta.url,
);
const evidence = {
  runId,
  platform: process.platform,
  runtime: undefined,
  dockerServerVersion: undefined,
  imageId: undefined,
  activeAssertion: undefined,
  assertions: [],
  cleanup: { status: "pending", resources: [] },
  error: undefined,
  completedAt: undefined,
};

function writeEvidence() {
  writeFileSync(evidenceUrl, `${JSON.stringify(evidence, null, 2)}\n`);
}

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    ...options,
  }).trim();
}

function record(name, details) {
  evidence.assertions.push({
    name,
    status: "passed",
    completedAt: new Date().toISOString(),
    ...(details ? { details } : {}),
  });
  evidence.activeAssertion = undefined;
  writeEvidence();
  console.log(`PASS ${name}`);
}

function begin(name) {
  evidence.activeAssertion = name;
  writeEvidence();
}

async function assertion(name, operation) {
  begin(name);
  const details = await operation();
  record(name, details);
}

function staticAssertions() {
  assert.match(packageJson.scripts["sandbox:smoke"], /compose\.linux-gvisor\.yml/);
  assert.match(packageJson.scripts["sandbox:smoke"], /sandbox-smoke/);
  assert.doesNotMatch(packageJson.scripts["sandbox:smoke"], /runc/);
  assert.equal(
    packageJson.scripts["sandbox:security"],
    "node docker/sandbox/security.mjs",
  );
  assert.match(packageJson.scripts["sandbox:security:attacks"], /archive\.test\.ts/);
  assert.match(packageJson.scripts["sandbox:security:attacks"], /artifact-bridge\.test\.ts/);
  assert.match(workflow, /runs-on: \[self-hosted, Linux, gvisor\]/);
  assert.match(workflow, /pnpm sandbox:build/);
  assert.match(workflow, /pnpm sandbox:smoke/);
  assert.match(workflow, /pnpm sandbox:security:attacks/);
  assert.match(workflow, /pnpm sandbox:security/);
  assert.match(workflow, /sandbox-security-evidence\.json/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /SANDBOX_SECURITY_RUN_ID=iris-security-%s-%s/);
  assert.match(
    workflow,
    /--filter "label=iris\.security\.run=\$\{SANDBOX_SECURITY_RUN_ID\}"/,
  );
  assert.equal(
    workflow.match(
      /--filter "label=iris\.security\.run=\$\{SANDBOX_SECURITY_RUN_ID\}"/g,
    )?.length,
    2,
  );
  assert.match(workflow, /group: sandbox-gvisor-\$\{\{ github\.ref \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(
    workflow,
    /--filter\s+"?label=iris\.security\.run"?(?:\s|\)|$)/,
  );
  assert.doesNotMatch(
    workflow,
    /--filter\s+"?label=com\.iris-os\.sandbox-profile(?:=|"|\s|\)|$)/,
  );
  assert.match(workflow, /anchore\/sbom-action@v0/);
  assert.match(workflow, /iris-sandbox-runtime\.cdx\.json/);
  assert.doesNotMatch(workflow, /apt-get|install.*runsc|runtime=runc|\|\|\s*true/);
  assert.match(
    runtimeDockerfile,
    /^FROM python:3\.12-slim-bookworm@sha256:[a-f0-9]{64}/m,
  );
  assert.match(runtimeDockerfile, /requirements-runtime-\$\{TARGETARCH\}\.txt/);
  assert.match(
    runtimeDockerfile,
    /pip install --require-hashes --no-deps --only-binary=:all:/,
  );
  assert.match(
    runtimeDockerfile,
    /USER sandbox[\s\S]*RUN python \/usr\/local\/bin\/runtime-smoke\.py/,
  );
  assert.match(compose, /runtime: runsc/);
  assert.match(compose, /network_mode: none/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /pids_limit: 64/);
}

function removeContainer(id) {
  if (!id) return;
  const result = spawnSync("docker", ["rm", "--force", id], {
    stdio: "ignore",
    timeout: 10_000,
  });
  evidence.cleanup.resources.push({
    type: "container",
    id,
    status: result.status === 0 ? "removed" : "failed",
  });
  if (result.status === 0) cleanupContainers.delete(id);
}

function removeNetwork(name) {
  if (!name) return;
  const result = spawnSync("docker", ["network", "rm", name], {
    stdio: "ignore",
    timeout: 10_000,
  });
  evidence.cleanup.resources.push({
    type: "network",
    id: name,
    status: result.status === 0 ? "removed" : "failed",
  });
  if (result.status === 0) cleanupNetworks.delete(name);
}

function removeSessionContainer(sessionId) {
  const listed = spawnSync(
    "docker",
    [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=com.iris-os.sandbox-session=${sessionId}`,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  const ids = listed.status === 0 ? listed.stdout.trim().split(/\s+/).filter(Boolean) : [];
  let failed = listed.status !== 0;
  for (const id of ids) {
    const removed = spawnSync("docker", ["rm", "--force", id], {
      stdio: "ignore",
      timeout: 10_000,
    });
    failed ||= removed.status !== 0;
  }
  evidence.cleanup.resources.push({
    type: "session",
    id: sessionId,
    status: failed ? "failed" : "removed",
  });
  if (!failed) cleanupSessions.delete(sessionId);
}

function cleanup() {
  for (const sessionId of [...cleanupSessions]) removeSessionContainer(sessionId);
  for (const id of [...cleanupContainers]) removeContainer(id);
  for (const name of [...cleanupNetworks]) removeNetwork(name);
  evidence.cleanup.status =
    cleanupSessions.size === 0 &&
    cleanupContainers.size === 0 &&
    cleanupNetworks.size === 0
      ? "completed"
      : "failed";
}

function createContainer(args) {
  const id = docker(["create", "--label", `iris.security.run=${runId}`, ...args]);
  cleanupContainers.add(id);
  return id;
}

function inspect(id) {
  return JSON.parse(docker(["inspect", id]))[0];
}

function assertTmpfsOptions(value, expected) {
  const options = new Set(value.split(","));
  for (const option of expected) {
    assert.ok(options.has(option), `tmpfs option ${option} is missing from ${value}`);
  }
}

function startAndWait(id, timeout = 15_000) {
  docker(["start", id]);
  const result = spawnSync("docker", ["wait", id], {
    cwd: root,
    encoding: "utf8",
    timeout,
  });
  if (result.error?.code === "ETIMEDOUT") {
    removeContainer(id);
    throw new Error(`container ${id} exceeded bounded test timeout`);
  }
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim());
}

function assertContainerGoneForSession(sessionId) {
  const ids = docker([
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `label=com.iris-os.sandbox-session=${sessionId}`,
  ]);
  assert.equal(ids, "", `sandbox container survived for session ${sessionId}`);
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100, undefined, { signal: AbortSignal.timeout(1_000) });
  }
  throw new Error(message);
}

function boundedFetch(url, options = {}, timeoutMs = 5_000) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return fetch(url, {
    ...options,
    signal: options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout,
  });
}

function boundedWait(operation, timeoutMs = 5_000) {
  const signal = AbortSignal.timeout(timeoutMs);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function makeArchive(entries) {
  const pack = tar.pack();
  const chunks = [];
  pack.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const finished = new Promise((resolve, reject) => {
    pack.once("end", resolve);
    pack.once("error", reject);
  });
  for (const { header, body = Buffer.alloc(0) } of entries) {
    await boundedWait(
      new Promise((resolve, reject) => {
        pack.entry(header, body, (error) =>
          error ? reject(error) : resolve(),
        );
      }),
    );
  }
  pack.finalize();
  await boundedWait(finished);
  return Buffer.concat(chunks);
}

async function runRunnerAssertions(imageId) {
  const runnerImage = docker([
    "compose",
    "-f",
    "docker/compose.yml",
    "-f",
    "docker/sandbox/compose.yml",
    "images",
    "--quiet",
    "sandbox-runner",
  ]);
  assert.ok(runnerImage, "sandbox runner image is required; run sandbox:build");
  const token = randomBytes(32).toString("hex");
  const runnerId = docker([
    "run",
    "--detach",
    "--label",
    `iris.security.run=${runId}`,
    "--publish",
    "127.0.0.1::8787",
    "--volume",
    "/var/run/docker.sock:/var/run/docker.sock",
    "--env",
    `SANDBOX_RUNNER_TOKEN=${token}`,
    "--env",
    `SANDBOX_RUNNER_IMAGE=${imageId}`,
    "--env",
    "SANDBOX_RUNNER_HOST=0.0.0.0",
    "--env",
    "SANDBOX_RUNNER_PORT=8787",
    "--env",
    "SANDBOX_RUNNER_MAX_EXEC_OUTPUT_BYTES=4096",
    "--env",
    "SANDBOX_RUNNER_MAX_CONCURRENT_SESSIONS=1",
    "--env",
    "SANDBOX_RUNNER_MAX_BODY_BYTES=1048576",
    "--env",
    "SANDBOX_RUNNER_MAX_FILE_BYTES=524288",
    "--env",
    "SANDBOX_RUNNER_MAX_ARCHIVE_BYTES=1048576",
    "--env",
    "SANDBOX_RUNNER_SESSION_TTL_MS=5000",
    "--env",
    "SANDBOX_RUNNER_IDLE_TTL_MS=5000",
    "--env",
    "SANDBOX_RUNNER_REAPER_INTERVAL_MS=1000",
    "--env",
    `SANDBOX_SECURITY_RUN_ID=${runId}`,
    runnerImage,
  ]);
  cleanupContainers.add(runnerId);
  const port = docker(["port", runnerId, "8787/tcp"]).split(":").at(-1);
  assert.match(port, /^\d+$/);
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  await waitFor(async () => {
    try {
      return (await boundedFetch(`${base}/ready`, { headers })).ok;
    } catch {
      return false;
    }
  }, "real sandbox runner did not become ready with runsc");

  async function createSession(limits = {}) {
    const response = await boundedFetch(`${base}/v1/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        identity: { sessionId: randomUUID(), rootRunId: randomUUID() },
        profile: { id: "security-adversarial", network: "none" },
        limits: {
          cpuMillis: 100,
          memoryMb: 32,
          tmpfsMb: 2,
          pidsLimit: 16,
          executionTimeoutMs: 500,
          idleTimeoutMs: 5_000,
          absoluteTimeoutMs: 5_000,
          ...limits,
        },
      }),
    });
    assert.equal(response.status, 201, await response.text());
    const session = await response.json();
    cleanupSessions.add(session.id);
    return session;
  }

  async function deleteSession(session) {
    const response = await boundedFetch(`${base}/v1/sessions/${session.id}`, {
      method: "DELETE",
      headers,
    });
    assert.ok([204, 404].includes(response.status), await response.text());
    cleanupSessions.delete(session.id);
  }

  async function assertDestroyed(session) {
    await waitFor(async () => {
      const response = await boundedFetch(`${base}/v1/sessions/${session.id}`, {
        headers,
      });
      return response.status === 404;
    }, `session ${session.id} was not quarantined`);
    assertContainerGoneForSession(session.id);
    cleanupSessions.delete(session.id);
  }

  await assertion("runner accepts upload, execution, and captured download", async () => {
    const session = await createSession();
    const uploaded = await makeArchive([
      { header: { name: "input.txt" }, body: Buffer.from("runner-lifecycle") },
    ]);
    let response = await boundedFetch(
      `${base}/v1/sessions/${session.id}/files`,
      {
        method: "PUT",
        headers: { ...headers, "content-type": "application/x-tar" },
        body: uploaded,
      },
    );
    assert.equal(response.status, 204, await response.text());
    response = await boundedFetch(`${base}/v1/sessions/${session.id}/exec`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        cmd: [
          "python",
          "-c",
          "from pathlib import Path; Path('captured.txt').write_text(Path('input.txt').read_text() + '-captured')",
        ],
      }),
    });
    assert.equal(response.status, 200, await response.text());
    response = await boundedFetch(
      `${base}/v1/sessions/${session.id}/files?path=captured.txt`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(response.status, 200, await response.text());
    const capture = Buffer.from(await response.arrayBuffer());
    assert.ok(capture.includes(Buffer.from("runner-lifecycle-captured")));
    await deleteSession(session);
  });

  await assertion("runner rejects malicious archive uploads before runsc staging", async () => {
    for (const entries of [
      [{ header: { name: "../escape", type: "file" } }],
      [{ header: { name: "link", type: "symlink", linkname: "/etc/passwd" } }],
      [{ header: { name: "oversized" }, body: Buffer.alloc(524_289) }],
    ]) {
      const session = await createSession();
      const response = await boundedFetch(
        `${base}/v1/sessions/${session.id}/files`,
        {
          method: "PUT",
          headers: { ...headers, "content-type": "application/x-tar" },
          body: await makeArchive(entries),
        },
      );
      assert.equal(response.status, 400, await response.text());
      await deleteSession(session);
    }
    return "Traversal, symlink, and oversized archives exercised through the runner upload API; unit attacks retain malformed/special/count coverage.";
  });

  await assertion("bounded tmpfs rejects workspace and tmp fill", async () => {
    const session = await createSession({
      tmpfsMb: 1,
      executionTimeoutMs: 5_000,
    });
    const response = await boundedFetch(
      `${base}/v1/sessions/${session.id}/exec`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          cmd: [
            "python",
            "-c",
            "import errno,os\nfor p in ('/workspace/fill','/tmp/fill'):\n try:\n  with open(p,'wb',buffering=0) as f:\n   while True: f.write(b'x'*65536)\n except OSError as e: assert e.errno in (errno.ENOSPC,errno.EDQUOT)\n assert os.path.getsize(p) <= 2*1024*1024",
          ],
        }),
      },
      10_000,
    );
    assert.equal(response.status, 200, await response.text());
    await deleteSession(session);
  });

  await assertion("maximum concurrent session capacity is rejected", async () => {
    const session = await createSession();
    const response = await boundedFetch(`${base}/v1/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        identity: { sessionId: randomUUID(), rootRunId: randomUUID() },
        profile: { id: "security-adversarial", network: "none" },
        limits: {
          cpuMillis: 100,
          memoryMb: 32,
          tmpfsMb: 1,
          pidsLimit: 16,
          executionTimeoutMs: 500,
          idleTimeoutMs: 5_000,
          absoluteTimeoutMs: 5_000,
        },
      }),
    });
    assert.equal(response.status, 429, await response.text());
    await deleteSession(session);
  });

  await assertion("idle TTL reaps an inactive runner session", async () => {
    const session = await createSession({
      idleTimeoutMs: 1_000,
      absoluteTimeoutMs: 5_000,
    });
    await assertDestroyed(session);
  });

  await assertion("absolute TTL reaps a session despite activity", async () => {
    const session = await createSession({
      idleTimeoutMs: 5_000,
      absoluteTimeoutMs: 2_000,
    });
    const deadline = Date.now() + 4_500;
    while (Date.now() < deadline) {
      const response = await boundedFetch(
        `${base}/v1/sessions/${session.id}/files`,
        {
          method: "PUT",
          headers: { ...headers, "content-type": "application/x-tar" },
          body: await makeArchive([
            { header: { name: "touch" }, body: Buffer.from("x") },
          ]),
        },
      );
      if (response.status === 404) break;
      assert.equal(response.status, 204, await response.text());
      await delay(250, undefined, { signal: AbortSignal.timeout(1_000) });
    }
    await assertDestroyed(session);
  });

  begin("stdout overflow quarantines and destroys the session");
  let session = await createSession();
  let response = await boundedFetch(`${base}/v1/sessions/${session.id}/exec`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      cmd: ["python", "-c", "import sys;sys.stdout.write('x'*8192)"],
    }),
  });
  assert.equal(response.status, 502, await response.text());
  await assertDestroyed(session);
  record("stdout overflow quarantines and destroys the session");

  begin("CPU loop is quota-limited, times out, and destroys the session");
  session = await createSession();
  response = await boundedFetch(`${base}/v1/sessions/${session.id}/exec`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      cmd: ["python", "-c", "while True: pass"],
      timeoutMs: 300,
    }),
  });
  assert.equal(response.status, 408, await response.text());
  await assertDestroyed(session);
  record("CPU loop is quota-limited, times out, and destroys the session");

  begin("caller cancellation destroys the session container");
  session = await createSession();
  const controller = new AbortController();
  const execution = boundedFetch(`${base}/v1/sessions/${session.id}/exec`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      cmd: ["python", "-c", "import time;time.sleep(10)"],
    }),
    signal: controller.signal,
  }).catch(() => undefined);
  await delay(200, undefined, { signal: AbortSignal.timeout(1_000) });
  controller.abort();
  await execution;
  await assertDestroyed(session);
  record("caller cancellation destroys the session container");

  removeContainer(runnerId);
}

async function main() {
  if (!process.argv.includes("--static")) writeEvidence();
  staticAssertions();
  if (process.argv.includes("--static")) {
    console.log(
      "sandbox security definitions passed (static only; runsc was not executed)",
    );
    return;
  }
  assert.match(
    runId ?? "",
    /^iris-security-[A-Za-z0-9_.-]+$/,
    "SANDBOX_SECURITY_RUN_ID must identify this workflow run",
  );
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
  evidence.runtime = "runsc";
  evidence.dockerServerVersion = docker(["version", "--format", "{{.Server.Version}}"]) || undefined;

  const image = process.env.SANDBOX_RUNTIME_IMAGE ?? "iris-sandbox-runtime:local";
  const imageId = docker(["image", "inspect", "--format", "{{.Id}}", image]);
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  evidence.imageId = imageId;

  begin("runsc identity, readonly root, writable bounded tmpfs, and host isolation");
  const hardened = createContainer([
    "--runtime=runsc",
    "--network=none",
    "--read-only",
    "--user=10001:10001",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--pids-limit=16",
    "--memory=32m",
    "--memory-swap=32m",
    "--cpus=0.1",
    "--tmpfs=/tmp:rw,size=2m,noexec,nosuid,nodev,uid=10001,gid=10001,mode=700",
    "--tmpfs=/workspace:rw,size=2m,noexec,nosuid,nodev,uid=10001,gid=10001,mode=700",
    image,
    "python",
    "-c",
    [
      "import os,pathlib,tempfile",
      "assert (os.getuid(),os.getgid()) == (10001,10001)",
      "s=pathlib.Path('/proc/self/status').read_text()",
      "assert 'NoNewPrivs:\\t1' in s and 'CapEff:\\t0000000000000000' in s",
      "for p in ('/tmp/probe','/workspace/probe'): pathlib.Path(p).write_text('ok')",
      "try: pathlib.Path('/security-write-test').write_text('denied'); raise AssertionError('writable root')",
      "except OSError: pass",
      "assert not pathlib.Path('/var/run/docker.sock').exists()",
    ].join("\n"),
  ]);
  const hardenedInspect = inspect(hardened);
  const host = hardenedInspect.HostConfig;
  assert.equal(host.Runtime, "runsc");
  assert.equal(host.NetworkMode, "none");
  assert.equal(host.ReadonlyRootfs, true);
  assert.equal(hardenedInspect.Config.User, "10001:10001");
  assert.deepEqual(host.CapDrop, ["ALL"]);
  assert.equal(host.Privileged, false);
  assert.equal((host.Binds ?? []).length, 0);
  assert.equal((host.Mounts ?? []).length, 0);
  assert.equal((host.Devices ?? []).length, 0);
  assert.equal((host.DeviceRequests ?? []).length, 0);
  assert.equal(host.PidsLimit, 16);
  assert.equal(host.Memory, 32 * 1024 * 1024);
  assert.equal(host.MemorySwap, 32 * 1024 * 1024);
  assert.equal(host.NanoCpus, 100_000_000);
  assert.ok(["private", ""].includes(host.IpcMode));
  assert.notEqual(host.PidMode, "host");
  assert.notEqual(host.UTSMode, "host");
  assert.notEqual(host.CgroupnsMode, "host");
  const tmpfsOptions = ["rw", "size=2097152", "noexec", "nosuid", "nodev"];
  assertTmpfsOptions(host.Tmpfs["/tmp"], tmpfsOptions);
  assertTmpfsOptions(host.Tmpfs["/workspace"], tmpfsOptions);
  assert.equal(startAndWait(hardened), 0);
  removeContainer(hardened);
  record("runsc identity, readonly root, writable bounded tmpfs, and host isolation");

  begin("controlled internet, service, metadata, and sibling canaries are unreachable");
  const network = `${runId}-canary`;
  docker(["network", "create", "--internal", "--label", `iris.security.run=${runId}`, network]);
  cleanupNetworks.add(network);
  const canary = docker([
    "run",
    "--detach",
    "--label",
    `iris.security.run=${runId}`,
    "--network",
    network,
    ...["internet", "runner", "iris", "postgres", "redis", "metadata", "sibling-sandbox"].flatMap((alias) => ["--network-alias", alias]),
    image,
    "python",
    "-m",
    "http.server",
    "8080",
  ]);
  cleanupContainers.add(canary);
  const canaryIp = inspect(canary).NetworkSettings.Networks[network].IPAddress;
  assert.match(canaryIp, /^\d+\.\d+\.\d+\.\d+$/);
  const denied = createContainer([
    "--runtime=runsc",
    "--network=none",
    "--read-only",
    "--user=10001:10001",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--pids-limit=8",
    "--memory=32m",
    "--cpus=0.1",
    "--tmpfs=/tmp:rw,size=1m,noexec,nosuid,nodev",
    "--tmpfs=/workspace:rw,size=1m,noexec,nosuid,nodev",
    image,
    "python",
    "-c",
    [
      "import socket",
      `targets=${JSON.stringify([canaryIp, "internet", "runner", "iris", "postgres", "redis", "metadata", "sibling-sandbox", "169.254.169.254", "1.1.1.1"])}`,
      "for target in targets:",
      " try: socket.create_connection((target,8080),0.2); raise AssertionError('reachable '+target)",
      " except (OSError,socket.gaierror): pass",
    ].join("\n"),
  ]);
  assert.equal(startAndWait(denied), 0);
  removeContainer(denied);
  removeContainer(canary);
  removeNetwork(network);
  record("controlled internet, service, metadata, and sibling canaries are unreachable");

  begin("PID and fork pressure is constrained");
  const fork = createContainer([
    "--runtime=runsc",
    "--network=none",
    "--pids-limit=8",
    "--memory=32m",
    "--cpus=0.1",
    image,
    "python",
    "-c",
    "import os,time\np=[]\nfor _ in range(64):\n try:\n  x=os.fork()\n  if x==0: time.sleep(2);os._exit(0)\n  p.append(x)\n except OSError: break\nassert len(p)<64\nfor x in p: os.waitpid(x,0)",
  ]);
  assert.equal(startAndWait(fork, 10_000), 0);
  removeContainer(fork);
  record("PID and fork pressure is constrained");

  begin("memory pressure is constrained");
  const memory = createContainer([
    "--runtime=runsc",
    "--network=none",
    "--memory=32m",
    "--memory-swap=32m",
    "--pids-limit=8",
    "--cpus=0.1",
    image,
    "python",
    "-c",
    "x=bytearray(128*1024*1024);print(len(x))",
  ]);
  assert.notEqual(startAndWait(memory, 10_000), 0, "memory pressure escaped its limit");
  assert.equal(inspect(memory).HostConfig.Memory, 32 * 1024 * 1024);
  removeContainer(memory);
  record("memory pressure is constrained");

  await runRunnerAssertions(imageId);
  evidence.completedAt = new Date().toISOString();
  writeEvidence();
  console.log("sandbox security real runsc adversarial assertions passed");
}

process.once("SIGINT", () => {
  cleanup();
  evidence.completedAt = new Date().toISOString();
  evidence.error = "Interrupted by SIGINT";
  writeEvidence();
  process.exit(130);
});
process.once("SIGTERM", () => {
  cleanup();
  evidence.completedAt = new Date().toISOString();
  evidence.error = "Interrupted by SIGTERM";
  writeEvidence();
  process.exit(143);
});

try {
  await main();
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  evidence.assertions.push({
    name: evidence.activeAssertion ?? "security workflow completion",
    status: "failed",
    completedAt: new Date().toISOString(),
    error: evidence.error,
  });
  evidence.activeAssertion = undefined;
  throw error;
} finally {
  cleanup();
  evidence.completedAt = new Date().toISOString();
  if (!process.argv.includes("--static")) writeEvidence();
}
