export const HARNESS_CONTAINER_PREFIX = "iris-harness-pg-";

const inheritedHarnessVariables = [
  "CI",
  "FORCE_COLOR",
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

const generatedHarnessVariables = new Set([
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "E2E_DISABLE_AUTH_RATE_LIMIT",
  "HARNESS_AUTH_FILE",
  "HARNESS_DIST_DIR",
  "HARNESS_REPORT_DIR",
  "HOME",
  "IRIS_DELEGATION_V2",
  "IRIS_DISABLE_ENV_FILE_LOADING",
  "IRIS_REMOTE_AGENTS_A2A",
  "NEXT_PUBLIC_BASE_URL",
  "NO_HTTPS",
  "OPERATIONS_METRICS_TOKEN",
  "PLAYWRIGHT_BROWSERS_PATH",
  "POSTGRES_URL",
]);

const blockedHarnessVariables = [
  "AI_SDK_OTEL_ENABLED",
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "BLOB_READ_WRITE_TOKEN",
  "DATABASE_URL",
  "DATADOG_API_KEY",
  "DD_API_KEY",
  "EXA_API_KEY",
  "FILE_BASED_MCP_CONFIG",
  "FILE_STORAGE_PREFIX",
  "FILE_STORAGE_S3_BUCKET",
  "FILE_STORAGE_S3_ENDPOINT",
  "FILE_STORAGE_S3_FORCE_PATH_STYLE",
  "FILE_STORAGE_S3_PUBLIC_BASE_URL",
  "FILE_STORAGE_S3_REGION",
  "FILE_STORAGE_TYPE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
  "GROQ_BASE_URL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "MCP_CONFIG_PATH",
  "MCP_MAX_TOTAL_TIMEOUT",
  "MODEL_SETTINGS_ENCRYPTION_KEY",
  "NO_PROXY",
  "OLLAMA_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "REMOTE_AGENT_ENCRYPTION_KEY",
  "REDIS_URL",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_DSN",
  "TEST_POSTGRES_URL",
  "VERCEL_BLOB_API_URL",
  "XAI_API_KEY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy",
] as const;

export function createHarnessEnvironment(
  inherited: Record<string, string | undefined>,
  values: Record<string, string>,
): NodeJS.ProcessEnv {
  const environment: Record<string, string | undefined> = {};
  for (const variable of inheritedHarnessVariables) {
    if (inherited[variable] !== undefined) {
      environment[variable] = inherited[variable];
    }
  }
  for (const variable of blockedHarnessVariables) {
    environment[variable] = "";
  }
  for (const variable of [
    "AZURE_OPENAI_ENDPOINT",
    "FILE_STORAGE_S3_ENDPOINT",
    "GROQ_BASE_URL",
    "OLLAMA_BASE_URL",
    "OPENAI_BASE_URL",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "VERCEL_BLOB_API_URL",
  ]) {
    environment[variable] = "http://127.0.0.1:1";
  }
  for (const variable of Object.keys(values)) {
    if (!generatedHarnessVariables.has(variable)) {
      throw new Error(`Refusing unexpected Harness variable: ${variable}`);
    }
  }

  return { ...environment, ...values } as NodeJS.ProcessEnv;
}

export function assertHarnessContainerName(name: string): void {
  if (
    !name.startsWith(HARNESS_CONTAINER_PREFIX) ||
    !/^iris-harness-pg-[a-z0-9]+$/.test(name)
  ) {
    throw new Error(`Refusing to manage non-Harness container: ${name}`);
  }
}

export function parseLoopbackPort(output: string): number {
  const binding = output.trim();
  const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
  const port = Number(match?.[1]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Docker exposed PostgreSQL unsafely: ${binding}`);
  }
  return port;
}

export function playwrightBrowsersPath(home: string | undefined): string {
  if (!home || !home.startsWith("/")) {
    throw new Error("Harness requires an absolute host home for Playwright");
  }
  return `${home}/Library/Caches/ms-playwright`;
}
