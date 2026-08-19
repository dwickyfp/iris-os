import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { getV2FeatureFlags } from "../../feature-flags";
import type { SafeTarget } from "./safety";

function run(command: string, args: string[], env?: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}

function dockerConnectionString(connectionString: string) {
  const url = new URL(connectionString);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
    url.hostname = "host.docker.internal";
  }
  return url.toString();
}

async function runPostgresTool(
  command: "pg_dump" | "pg_restore",
  args: string[],
  file: string,
) {
  try {
    await run(command, args);
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    ) {
      throw error;
    }
    const directory = path.dirname(path.resolve(file));
    const containerFile = `/backup/${path.basename(file)}`;
    const containerArgs = args.map((argument) => {
      if (argument === file) return containerFile;
      if (
        argument.startsWith("postgres://") ||
        argument.startsWith("postgresql://")
      ) {
        return dockerConnectionString(argument);
      }
      return argument;
    });
    await run("docker", [
      "run",
      "--rm",
      "--volume",
      `${directory}:/backup`,
      process.env.MIGRATION_PG_TOOLS_IMAGE ?? "pgvector/pgvector:pg17",
      command,
      ...containerArgs,
    ]);
  }
}

export async function createBackup(target: SafeTarget, file: string) {
  await runPostgresTool(
    "pg_dump",
    ["--format=custom", "--no-owner", "--file", file, target.connectionString],
    file,
  );
}

export async function restoreBackup(target: SafeTarget, file: string) {
  await access(file);
  await runPostgresTool(
    "pg_restore",
    [
      "--exit-on-error",
      "--no-owner",
      "--clean",
      "--if-exists",
      "--dbname",
      target.connectionString,
      file,
    ],
    file,
  );
}

export function flagsOffProbe() {
  const flags = getV2FeatureFlags({
    IRIS_WORKSPACES_V2: "0",
    IRIS_LEARNING_V2: "0",
    IRIS_AUTOMATION_V2: "0",
    IRIS_DELEGATION_V2: "0",
    IRIS_REMOTE_AGENTS_A2A: "0",
  });
  return Object.values(flags).every((enabled) => !enabled);
}
