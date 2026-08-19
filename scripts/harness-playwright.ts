import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { Client } from "pg";
import {
  HARNESS_CONTAINER_PREFIX,
  assertHarnessContainerName,
  createHarnessEnvironment,
  parseLoopbackPort,
  playwrightBrowsersPath,
} from "./harness-safety";

const root = process.cwd();
const runId = randomBytes(6).toString("hex");
const containerName = `${HARNESS_CONTAINER_PREFIX}${runId}`;
const runDir = resolve(root, ".harness", runId);
const distDir = `.harness/${runId}/next`;
const authDir = resolve(runDir, "auth");
const reportDir = resolve(runDir, "report");
const password = randomBytes(24).toString("hex");
const tsconfigPath = resolve(root, "tsconfig.json");
const originalTsconfig = await readFile(tsconfigPath);
let generatedTsconfig: Buffer | undefined;
let activeChild: ChildProcess | undefined;
let containerStarted = false;
let cleaning = false;

assertHarnessContainerName(containerName);

function docker(args: string[], options?: { allowFailure?: boolean }): string {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0 && !options?.allowFailure) {
    throw new Error(result.stderr.trim() || `docker ${args[0]} failed`);
  }
  return result.stdout;
}

async function run(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      detached: true,
      env: environment,
      stdio: "inherit",
    });
    activeChild = child;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      activeChild = undefined;
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${signal ?? code}`));
    });
  });
}

async function unusedLoopbackPort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port"));
        return;
      }
      server.close((error) =>
        error ? reject(error) : resolvePromise(address.port),
      );
    });
  });
}

async function waitForPostgres(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = spawnSync(
      "docker",
      ["exec", containerName, "pg_isready", "-U", "harness", "-d", "harness"],
      { stdio: "ignore" },
    );
    if (result.status === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error("Disposable PostgreSQL did not become ready");
}

async function verifyDatabase(postgresUrl: string): Promise<void> {
  const client = new Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    const migration = await client.query<{ has_0046: boolean; count: string }>(
      'SELECT BOOL_OR(created_at = 1787133600000) AS has_0046, COUNT(*)::text AS count FROM drizzle."__drizzle_migrations"',
    );
    if (!migration.rows[0]?.has_0046 || Number(migration.rows[0]?.count) < 47) {
      throw new Error(
        `Expected Drizzle migrations through 0046, received ${JSON.stringify(migration.rows[0])}`,
      );
    }

    const requiredTables = [
      "user",
      "session",
      "account",
      "verification",
      "remote_agent",
      "agent_run",
      "artifact",
      "agent_run_join",
    ];
    const tables = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])",
      [requiredTables],
    );
    const present = new Set(tables.rows.map((row) => row.table_name));
    const missing = requiredTables.filter((table) => !present.has(table));
    if (missing.length)
      throw new Error(`Missing required tables: ${missing.join(", ")}`);

    const generation = await client.query(
      "SELECT checkpoint_generation FROM agent_run_join LIMIT 0",
    );
    if (!generation)
      throw new Error("Migration 0045 column verification failed");
  } finally {
    await client.end();
  }
}

async function cleanup(): Promise<void> {
  if (cleaning) return;
  cleaning = true;
  if (containerStarted) {
    assertHarnessContainerName(containerName);
    docker(["rm", "-f", containerName], { allowFailure: true });
    containerStarted = false;
  }
  const currentTsconfig = await readFile(tsconfigPath);
  if (
    generatedTsconfig &&
    currentTsconfig.equals(generatedTsconfig) &&
    !currentTsconfig.equals(originalTsconfig)
  ) {
    await writeFile(tsconfigPath, originalTsconfig);
  }
  await Promise.all([
    rm(resolve(root, distDir), { recursive: true, force: true }),
    rm(authDir, { recursive: true, force: true }),
  ]);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (activeChild?.pid) {
      try {
        process.kill(-activeChild.pid, signal);
      } catch {
        activeChild.kill(signal);
      }
    }
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

let exitCode = 0;
try {
  docker(["info"]);
  docker([
    "run",
    "--detach",
    "--name",
    containerName,
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    "POSTGRES_USER=harness",
    "--env",
    "POSTGRES_DB=harness",
    "--publish",
    "127.0.0.1::5432",
    "pgvector/pgvector:pg16",
  ]);
  containerStarted = true;
  await waitForPostgres();

  const databasePort = parseLoopbackPort(
    docker(["port", containerName, "5432/tcp"]),
  );
  const appPort = await unusedLoopbackPort();
  const postgresUrl = `postgresql://harness:${password}@127.0.0.1:${databasePort}/harness`;
  const baseURL = `http://127.0.0.1:${appPort}`;
  const environment = createHarnessEnvironment(process.env, {
    HOME: resolve(runDir, "home"),
    POSTGRES_URL: postgresUrl,
    NEXT_PUBLIC_BASE_URL: baseURL,
    BETTER_AUTH_URL: baseURL,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    OPERATIONS_METRICS_TOKEN: randomBytes(32).toString("hex"),
    PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(process.env.HOME),
    NO_HTTPS: "1",
    E2E_DISABLE_AUTH_RATE_LIMIT: "1",
    IRIS_DELEGATION_V2: "1",
    IRIS_DISABLE_ENV_FILE_LOADING: "1",
    IRIS_REMOTE_AGENTS_A2A: "1",
    HARNESS_DIST_DIR: distDir,
    HARNESS_AUTH_FILE: resolve(authDir, "editor.json"),
    HARNESS_REPORT_DIR: reportDir,
  });
  await mkdir(environment.HOME!, { recursive: true });

  console.log(`Harness run ${runId}: PostgreSQL 127.0.0.1:${databasePort}`);
  await run("pnpm", ["db:migrate"], environment);
  await verifyDatabase(postgresUrl);
  console.log("Verified Drizzle migrations through 0046 and required tables");
  await run(
    "pnpm",
    ["exec", "tsx", "scripts/seed-harness-user.ts"],
    environment,
  );
  await run("pnpm", ["exec", "next", "build"], environment);
  generatedTsconfig = await readFile(tsconfigPath);
  if (!generatedTsconfig.equals(originalTsconfig)) {
    await writeFile(tsconfigPath, originalTsconfig);
  }
  await run(
    "pnpm",
    ["exec", "playwright", "test", "--config", "playwright.harness.config.ts"],
    environment,
  );
  console.log(`Harness report: ${reportDir}`);
} catch (error) {
  exitCode = 1;
  console.error(error instanceof Error ? error.message : error);
  console.error(`Harness failure report: ${reportDir}`);
} finally {
  await cleanup();
}

process.exit(exitCode);
