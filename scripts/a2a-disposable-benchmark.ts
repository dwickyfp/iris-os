import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import {
  A2A_BENCHMARK_CONTAINER_PREFIX,
  A2A_BENCHMARK_DATABASE_PREFIX,
  A2A_BENCHMARK_GUARD_TABLE,
  A2A_BENCHMARK_MARKER_PREFIX,
  assertDisposableBenchmarkContainerName,
  assertDisposableBenchmarkProof,
  benchmarkIterations,
  createDisposableBenchmarkEnvironment,
  createDisposablePostgresUrl,
  parseDisposableLoopbackPort,
} from "./a2a-disposable-benchmark-safety";

const root = process.cwd();
const runId = randomBytes(6).toString("hex");
const containerName = `${A2A_BENCHMARK_CONTAINER_PREFIX}${runId}`;
const database = `${A2A_BENCHMARK_DATABASE_PREFIX}${runId}`;
const password = randomBytes(24).toString("hex");
const disposableToken = randomBytes(32).toString("hex");
const wrapperNonce = randomBytes(24).toString("hex");
const disposableMarker = `${A2A_BENCHMARK_MARKER_PREFIX}${runId}`;
const iterations = benchmarkIterations(process.env.A2A_BENCHMARK_ITERATIONS);
const image = "pgvector/pgvector:pg17";
const artifactPath = resolve(
  root,
  "artifacts",
  "benchmarks",
  `a2a-disposable-${runId}.json`,
);

let activeChild: ChildProcess | undefined;
let containerStarted = false;
let cleaning = false;

assertDisposableBenchmarkContainerName(containerName);

function docker(args: string[], allowFailure = false): string {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr.trim() || `docker ${args[0]} failed`);
  }
  return result.stdout;
}

function cleanup(): boolean {
  if (cleaning) return !containerStarted;
  cleaning = true;
  if (containerStarted) {
    assertDisposableBenchmarkContainerName(containerName);
    const result = spawnSync("docker", ["rm", "--force", containerName], {
      stdio: "ignore",
    });
    if (result.status !== 0) return false;
    containerStarted = false;
  }
  return true;
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    if (activeChild?.pid) {
      try {
        process.kill(-activeChild.pid, signal);
      } catch {
        activeChild.kill(signal);
      }
    }
    cleanup();
    const exitCode =
      signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129;
    process.exit(exitCode);
  });
}

async function runChild(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  captureJson = false,
): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    const child = spawn(command, args, {
      cwd: root,
      detached: true,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;
    child.stdout.on("data", (chunk) => {
      if (captureJson) stdout += chunk.toString();
      else process.stderr.write(chunk);
    });
    child.stderr.pipe(process.stderr);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      activeChild = undefined;
      if (code !== 0) {
        reject(new Error(`${command} exited with ${signal ?? code}`));
        return;
      }
      if (!captureJson) {
        resolvePromise(undefined);
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        reject(new Error("A2A benchmark did not emit valid JSON"));
      }
    });
  });
}

async function waitForPostgres(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = spawnSync(
      "docker",
      ["exec", containerName, "pg_isready", "-U", "iris", "-d", database],
      { stdio: "ignore" },
    );
    if (ready.status === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    "Disposable PostgreSQL did not become ready within 60 seconds",
  );
}

async function verifyLatestMigration(connectionString: string) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{
      count: string;
      has_0046: boolean;
      heartbeat_table: string | null;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM drizzle."__drizzle_migrations") AS count,
         (SELECT BOOL_OR(created_at = 1787133600000)
            FROM drizzle."__drizzle_migrations") AS has_0046,
         to_regclass('public.iris_worker_heartbeat')::text AS heartbeat_table`,
    );
    const row = result.rows[0];
    if (
      !row?.has_0046 ||
      Number(row.count) < 47 ||
      row.heartbeat_table !== "iris_worker_heartbeat"
    ) {
      throw new Error(
        `Expected migrations through 0046, received ${JSON.stringify(row)}`,
      );
    }
    return {
      latest: "0046_worker_heartbeat",
      appliedCount: Number(row.count),
      verified: true,
    };
  } finally {
    await client.end();
  }
}

async function createDisposableGuard(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE ${A2A_BENCHMARK_GUARD_TABLE} (
         database_name text PRIMARY KEY,
         disposable_marker text NOT NULL,
         disposable_token text NOT NULL,
         wrapper_nonce text NOT NULL
       )`,
    );
    await client.query(
      `INSERT INTO ${A2A_BENCHMARK_GUARD_TABLE}
         (database_name, disposable_marker, disposable_token, wrapper_nonce)
       VALUES ($1, $2, $3, $4)`,
      [database, disposableMarker, disposableToken, wrapperNonce],
    );
  } finally {
    await client.end();
  }
}

async function writeEvidence(evidence: object): Promise<void> {
  await mkdir(resolve(root, "artifacts", "benchmarks"), { recursive: true });
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(artifactPath, json);
  process.stdout.write(json);
}

let failure: unknown;
let migration: Awaited<ReturnType<typeof verifyLatestMigration>> | undefined;
let benchmark: unknown;
let loopbackPort: number | undefined;
const startedAt = new Date().toISOString();

try {
  docker(["info"]);
  docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    "POSTGRES_USER=iris",
    "--env",
    `POSTGRES_DB=${database}`,
    "--publish",
    "127.0.0.1::5432",
    image,
  ]);
  containerStarted = true;
  await waitForPostgres();
  loopbackPort = parseDisposableLoopbackPort(
    docker(["port", containerName, "5432/tcp"]),
  );
  const connectionString = createDisposablePostgresUrl({
    database,
    password,
    port: loopbackPort,
  });
  assertDisposableBenchmarkProof({
    connectionString,
    database,
    marker: disposableMarker,
    token: disposableToken,
    nonce: wrapperNonce,
    applicationDatabaseUrls: [
      process.env.POSTGRES_URL,
      process.env.DATABASE_URL,
      process.env.TEST_POSTGRES_URL,
    ],
  });
  const migrationEnvironment = createDisposableBenchmarkEnvironment(
    process.env,
    {
      IRIS_DISABLE_ENV_FILE_LOADING: "1",
      POSTGRES_URL: connectionString,
    },
  );
  await runChild("pnpm", ["db:migrate"], migrationEnvironment);
  migration = await verifyLatestMigration(connectionString);
  await createDisposableGuard(connectionString);
  const benchmarkEnvironment = createDisposableBenchmarkEnvironment(
    process.env,
    {
      A2A_BENCHMARK_POSTGRES_URL: connectionString,
      A2A_BENCHMARK_DATABASE: database,
      A2A_BENCHMARK_DISPOSABLE_MARKER: disposableMarker,
      A2A_BENCHMARK_DISPOSABLE_TOKEN: disposableToken,
      A2A_BENCHMARK_WRAPPER_NONCE: wrapperNonce,
      A2A_BENCHMARK_ITERATIONS: String(iterations),
      IRIS_DISABLE_ENV_FILE_LOADING: "1",
    },
  );
  benchmark = await runChild(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "scripts/a2a-lifecycle-benchmark.ts",
    ],
    benchmarkEnvironment,
    true,
  );
} catch (error) {
  failure = error;
}

const cleanedUp = cleanup();
const innerPassed =
  typeof benchmark === "object" &&
  benchmark !== null &&
  "passed" in benchmark &&
  benchmark.passed === true;
const passed =
  !failure && cleanedUp && migration?.verified === true && innerPassed;
const evidence = {
  schemaVersion: 1,
  benchmark: "a2a-disposable-postgres-wrapper",
  runId,
  startedAt,
  finishedAt: new Date().toISOString(),
  passed,
  configuration: {
    image,
    iterations,
    host: "127.0.0.1",
    randomDockerPort: true,
  },
  migration: migration ?? null,
  benchmarkResult: benchmark ?? null,
  invariants: {
    inheritedAppDatabaseIgnored: true,
    generatedDisposableDatabase: true,
    loopbackOnly: loopbackPort !== undefined,
    migratedThrough0046: migration?.verified === true,
    containerRemoved: cleanedUp,
  },
  error:
    failure instanceof Error
      ? failure.message
      : failure
        ? String(failure)
        : null,
  artifactPath,
};

await writeEvidence(evidence);
process.exitCode = passed ? 0 : 1;
