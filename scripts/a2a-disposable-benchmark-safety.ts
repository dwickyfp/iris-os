export const A2A_BENCHMARK_CONTAINER_PREFIX = "iris-a2a-benchmark-pg-";
export const A2A_BENCHMARK_DATABASE_PREFIX = "iris_a2a_benchmark_";
export const A2A_BENCHMARK_MARKER_PREFIX = "iris-a2a-disposable-";
export const A2A_BENCHMARK_GUARD_TABLE = "iris_a2a_benchmark_guard";

const inheritedBenchmarkVariables = [
  "CI",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "NO_COLOR",
  "NODE_ENV",
  "PATH",
  "SHELL",
  "TERM",
  "TMP",
  "TMPDIR",
  "TEMP",
  "TZ",
  "USER",
] as const;

const generatedBenchmarkVariables = new Set([
  "A2A_BENCHMARK_DATABASE",
  "A2A_BENCHMARK_DISPOSABLE_MARKER",
  "A2A_BENCHMARK_DISPOSABLE_TOKEN",
  "A2A_BENCHMARK_ITERATIONS",
  "A2A_BENCHMARK_POSTGRES_URL",
  "A2A_BENCHMARK_WRAPPER_NONCE",
  "IRIS_DISABLE_ENV_FILE_LOADING",
  "POSTGRES_URL",
]);

export function createDisposableBenchmarkEnvironment(
  inherited: Record<string, string | undefined>,
  values: Record<string, string>,
): NodeJS.ProcessEnv {
  const environment: Record<string, string | undefined> = {};
  for (const variable of inheritedBenchmarkVariables) {
    if (inherited[variable] !== undefined) {
      environment[variable] = inherited[variable];
    }
  }
  for (const variable of Object.keys(values)) {
    if (!generatedBenchmarkVariables.has(variable)) {
      throw new Error(`Refusing unexpected benchmark variable: ${variable}`);
    }
  }

  return { ...environment, ...values } as NodeJS.ProcessEnv;
}

export type DisposableBenchmarkProof = {
  connectionString: string;
  database: string;
  marker: string;
  token: string;
  nonce: string;
  applicationDatabaseUrls?: Array<string | undefined>;
};

function postgresTargetIdentity(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      return undefined;
    }
    return JSON.stringify([
      url.hostname.toLowerCase(),
      url.port || "5432",
      decodeURIComponent(url.pathname.slice(1)),
    ]);
  } catch {
    return undefined;
  }
}

export function assertDisposableBenchmarkProof(
  input: DisposableBenchmarkProof,
): void {
  const suffix = input.database.slice(A2A_BENCHMARK_DATABASE_PREFIX.length);
  const url = new URL(input.connectionString);
  const targetDatabase = decodeURIComponent(url.pathname.slice(1));
  if (!/^iris_a2a_benchmark_[a-f0-9]{12}$/.test(input.database)) {
    throw new Error("A2A benchmark requires an exact generated database name");
  }
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    targetDatabase !== input.database
  ) {
    throw new Error(
      "A2A benchmark target does not match the disposable database",
    );
  }
  if (input.marker !== `${A2A_BENCHMARK_MARKER_PREFIX}${suffix}`) {
    throw new Error("A2A benchmark requires its generated disposable marker");
  }
  if (!/^[a-f0-9]{64}$/.test(input.token)) {
    throw new Error("A2A benchmark requires its generated disposable token");
  }
  if (!/^[a-f0-9]{48}$/.test(input.nonce)) {
    throw new Error("A2A benchmark requires its wrapper-provided nonce");
  }
  if (
    input.applicationDatabaseUrls?.some(
      (candidate) =>
        candidate &&
        postgresTargetIdentity(candidate) ===
          postgresTargetIdentity(input.connectionString),
    )
  ) {
    throw new Error("A2A lifecycle benchmark refuses the application database");
  }
}

export function assertDisposableBenchmarkContainerName(name: string): void {
  if (
    !name.startsWith(A2A_BENCHMARK_CONTAINER_PREFIX) ||
    !/^iris-a2a-benchmark-pg-[a-f0-9]{12}$/.test(name)
  ) {
    throw new Error(`Refusing to manage non-benchmark container: ${name}`);
  }
}

export function parseDisposableLoopbackPort(output: string): number {
  const binding = output.trim();
  const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
  const port = Number(match?.[1]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Docker exposed PostgreSQL unsafely: ${binding}`);
  }
  return port;
}

export function benchmarkIterations(value: string | undefined): number {
  const iterations = Number(value ?? 10);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100) {
    throw new Error(
      "A2A_BENCHMARK_ITERATIONS must be an integer from 1 to 100 for the disposable wrapper",
    );
  }
  return iterations;
}

export function createDisposablePostgresUrl(input: {
  database: string;
  password: string;
  port: number;
}): string {
  if (
    !input.database.startsWith(A2A_BENCHMARK_DATABASE_PREFIX) ||
    !/^iris_a2a_benchmark_[a-f0-9]{12}$/.test(input.database)
  ) {
    throw new Error("Refusing a non-generated benchmark database name");
  }
  if (!/^[a-f0-9]{48}$/.test(input.password)) {
    throw new Error("Refusing a non-generated benchmark password");
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error("Refusing an invalid benchmark PostgreSQL port");
  }

  const url = new URL("postgresql://iris@127.0.0.1");
  url.password = input.password;
  url.port = String(input.port);
  url.pathname = `/${input.database}`;
  return url.toString();
}
