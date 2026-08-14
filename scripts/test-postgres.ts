import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const externalUrl = process.env.TEST_POSTGRES_URL;

function runTests(url: string) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn("pnpm", ["test:integration:db:run"], {
      env: { ...process.env, TEST_POSTGRES_URL: url },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function waitForPostgres(url: string) {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Disposable PostgreSQL did not become ready: ${lastError}`);
}

if (externalUrl) {
  process.exitCode = await runTests(externalUrl);
} else {
  const name = `iris-v2-test-${randomUUID().slice(0, 8)}`;
  const password = randomUUID();
  const started = spawnSync(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "--env",
      "POSTGRES_USER=iris",
      "--env",
      "POSTGRES_DB=iris_test",
      "pgvector/pgvector:pg17",
    ],
    { encoding: "utf8" },
  );
  if (started.status !== 0) {
    throw new Error(started.stderr || "Unable to start PostgreSQL container");
  }

  const cleanup = () => {
    spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" });
  };
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  try {
    const portResult = spawnSync("docker", ["port", name, "5432/tcp"], {
      encoding: "utf8",
    });
    const port = portResult.stdout.trim().match(/:(\d+)$/)?.[1];
    if (!port) throw new Error("Unable to resolve disposable PostgreSQL port");
    const url = `postgresql://iris:${password}@127.0.0.1:${port}/iris_test`;
    await waitForPostgres(url);
    process.exitCode = await runTests(url);
  } finally {
    cleanup();
  }
}
