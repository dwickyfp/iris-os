import type {
  RedactedSystemSettingDto,
  SystemSettingKey,
  SystemSettingMutation,
  SystemSettingScalar,
  SystemSettingSensitivity,
} from "app-types/system-settings";
import { z } from "zod";

const optionalText = z.string().trim().max(4096).nullable();
const optionalUrl = z.string().url().max(2048).nullable();
const optionalUuid = z.string().uuid().nullable();
const timeout = z.number().int().min(1).max(300_000);

export type SystemSettingDefinition<T extends SystemSettingScalar> = {
  env: string;
  schema: z.ZodType<T>;
  sensitivity: SystemSettingSensitivity;
  default: T;
  restartRequired: boolean;
};

const define = <T extends SystemSettingScalar>(
  definition: SystemSettingDefinition<T>,
) => definition;

export const SYSTEM_SETTING_DEFINITIONS = {
  "exa.apiKey": define({
    env: "EXA_API_KEY",
    schema: optionalText,
    sensitivity: "secret",
    default: null,
    restartRequired: false,
  }),
  "exa.baseUrl": define({
    env: "EXA_BASE_URL",
    schema: z.string().url().max(2048),
    sensitivity: "public",
    default: "https://api.exa.ai",
    restartRequired: false,
  }),
  "oauth.github.clientId": define({
    env: "GITHUB_CLIENT_ID",
    schema: optionalText,
    sensitivity: "public",
    default: null,
    restartRequired: true,
  }),
  "oauth.github.clientSecret": define({
    env: "GITHUB_CLIENT_SECRET",
    schema: optionalText,
    sensitivity: "secret",
    default: null,
    restartRequired: true,
  }),
  "oauth.google.clientId": define({
    env: "GOOGLE_CLIENT_ID",
    schema: optionalText,
    sensitivity: "public",
    default: null,
    restartRequired: true,
  }),
  "oauth.google.clientSecret": define({
    env: "GOOGLE_CLIENT_SECRET",
    schema: optionalText,
    sensitivity: "secret",
    default: null,
    restartRequired: true,
  }),
  "oauth.google.forceAccountSelection": define({
    env: "GOOGLE_FORCE_ACCOUNT_SELECTION",
    schema: z.boolean(),
    sensitivity: "public",
    default: false,
    restartRequired: true,
  }),
  "oauth.microsoft.clientId": define({
    env: "MICROSOFT_CLIENT_ID",
    schema: optionalText,
    sensitivity: "public",
    default: null,
    restartRequired: true,
  }),
  "oauth.microsoft.clientSecret": define({
    env: "MICROSOFT_CLIENT_SECRET",
    schema: optionalText,
    sensitivity: "secret",
    default: null,
    restartRequired: true,
  }),
  "oauth.microsoft.tenantId": define({
    env: "MICROSOFT_TENANT_ID",
    schema: z.string().trim().min(1).max(256),
    sensitivity: "public",
    default: "common",
    restartRequired: true,
  }),
  "oauth.microsoft.forceAccountSelection": define({
    env: "MICROSOFT_FORCE_ACCOUNT_SELECTION",
    schema: z.boolean(),
    sensitivity: "public",
    default: false,
    restartRequired: true,
  }),
  "auth.emailSignInEnabled": define({
    env: "DISABLE_EMAIL_SIGN_IN",
    schema: z.boolean(),
    sensitivity: "public",
    default: true,
    restartRequired: true,
  }),
  "auth.emailSignUpEnabled": define({
    env: "DISABLE_EMAIL_SIGN_UP",
    schema: z.boolean(),
    sensitivity: "public",
    default: true,
    restartRequired: true,
  }),
  "auth.oauthSignUpEnabled": define({
    env: "DISABLE_SIGN_UP",
    schema: z.boolean(),
    sensitivity: "public",
    default: true,
    restartRequired: true,
  }),
  "auth.baseUrl": define({
    env: "BETTER_AUTH_URL",
    schema: optionalUrl.refine(
      (value) => value === null || /^https?:\/\//i.test(value),
      "URL must use HTTP or HTTPS",
    ),
    sensitivity: "public",
    default: null,
    restartRequired: true,
  }),
  "users.defaultRole": define({
    env: "DEFAULT_USER_ROLE",
    schema: z.enum(["admin", "editor", "user"]),
    sensitivity: "public",
    default: "editor",
    restartRequired: true,
  }),
  "features.workspaces": define({
    env: "IRIS_WORKSPACES_V2",
    schema: z.boolean(),
    sensitivity: "public",
    default: false,
    restartRequired: false,
  }),
  "features.learning": define({
    env: "IRIS_LEARNING_V2",
    schema: z.boolean(),
    sensitivity: "public",
    default: false,
    restartRequired: false,
  }),
  "features.automation": define({
    env: "IRIS_AUTOMATION_V2",
    schema: z.boolean(),
    sensitivity: "public",
    default: false,
    restartRequired: false,
  }),
  "features.delegation": define({
    env: "IRIS_DELEGATION_V2",
    schema: z.boolean(),
    sensitivity: "public",
    default: false,
    restartRequired: false,
  }),
  "features.remoteAgents": define({
    env: "IRIS_REMOTE_AGENTS_A2A",
    schema: z.boolean(),
    sensitivity: "public",
    default: false,
    restartRequired: false,
  }),
  "memory.curatorMode": define({
    env: "IRIS_MEMORY_CURATOR_MODE",
    schema: z.enum(["off", "shadow", "write"]),
    sensitivity: "public",
    default: "shadow",
    restartRequired: false,
  }),
  "memory.recallMode": define({
    env: "IRIS_MEMORY_RECALL_MODE",
    schema: z.enum(["keyword", "hybrid"]),
    sensitivity: "public",
    default: "keyword",
    restartRequired: false,
  }),
  "capabilityRouter.threshold": define({
    env: "CAPABILITY_ROUTER_THRESHOLD",
    schema: z.number().int().min(1).max(10_000),
    sensitivity: "public",
    default: 20,
    restartRequired: false,
  }),
  "capabilityRouter.topN": define({
    env: "CAPABILITY_ROUTER_TOP_N",
    schema: z.number().int().min(1).max(1_000),
    sensitivity: "public",
    default: 12,
    restartRequired: false,
  }),
  "capabilityRouter.minScore": define({
    env: "CAPABILITY_ROUTER_MIN_SCORE",
    schema: z.number().min(0).max(1),
    sensitivity: "public",
    default: 0.15,
    restartRequired: false,
  }),
  "capabilityRouter.timeoutMs": define({
    env: "CAPABILITY_ROUTER_TIMEOUT_MS",
    schema: timeout,
    sensitivity: "public",
    default: 25,
    restartRequired: false,
  }),
  "capabilityRouter.fallbackHardCap": define({
    env: "CAPABILITY_ROUTER_FALLBACK_HARD_CAP",
    schema: z.number().int().min(1).max(10_000),
    sensitivity: "public",
    default: 100,
    restartRequired: false,
  }),
  "ai.stepTimeoutMs": define({
    env: "AI_STEP_TIMEOUT_MS",
    schema: timeout,
    sensitivity: "public",
    default: 30_000,
    restartRequired: false,
  }),
  "mcp.allowUserServers": define({
    env: "NOT_ALLOW_ADD_MCP_SERVERS",
    schema: z.boolean(),
    sensitivity: "public",
    default: true,
    restartRequired: false,
  }),
  "mcp.maxTotalTimeoutMs": define({
    env: "MCP_MAX_TOTAL_TIMEOUT",
    schema: timeout.nullable(),
    sensitivity: "public",
    default: null,
    restartRequired: false,
  }),
  "providers.imageProviderId": define({
    env: "IMAGE_PROVIDER_ID",
    schema: optionalUuid,
    sensitivity: "public",
    default: null,
    restartRequired: false,
  }),
  "providers.realtimeProviderId": define({
    env: "REALTIME_PROVIDER_ID",
    schema: optionalUuid,
    sensitivity: "public",
    default: null,
    restartRequired: false,
  }),
  "legacy.modelSettingsEncryptionKey": define({
    env: "MODEL_SETTINGS_ENCRYPTION_KEY",
    schema: optionalText,
    sensitivity: "secret",
    default: null,
    restartRequired: false,
  }),
  "legacy.remoteAgentEncryptionKey": define({
    env: "REMOTE_AGENT_ENCRYPTION_KEY",
    schema: optionalText,
    sensitivity: "secret",
    default: null,
    restartRequired: false,
  }),
  "legacy.remoteAgentEncryptionKeyV1": define({
    env: "REMOTE_AGENT_ENCRYPTION_KEY_V1",
    schema: optionalText,
    sensitivity: "secret",
    default: null,
    restartRequired: false,
  }),
  "legacy.remoteAgentEncryptionKeyV2": define({
    env: "REMOTE_AGENT_ENCRYPTION_KEY_V2",
    schema: optionalText,
    sensitivity: "secret",
    default: null,
    restartRequired: false,
  }),
  "operations.metricsToken": define({
    env: "OPERATIONS_METRICS_TOKEN",
    schema: optionalText,
    sensitivity: "secret",
    default: null,
    restartRequired: false,
  }),
  "operations.readyTimeoutMs": define({
    env: "OPERATIONS_READY_TIMEOUT_MS",
    schema: z.number().int().min(250).max(10_000),
    sensitivity: "public",
    default: 3_000,
    restartRequired: false,
  }),
  "operations.queryTimeoutMs": define({
    env: "OPERATIONS_QUERY_TIMEOUT_MS",
    schema: z.number().int().min(100).max(5_000),
    sensitivity: "public",
    default: 2_000,
    restartRequired: false,
  }),
  "operations.workerRequired": define({
    env: "IRIS_WORKER_REQUIRED",
    schema: z.boolean(),
    sensitivity: "public",
    default: false,
    restartRequired: true,
  }),
  "operations.workerStaleAfterMs": define({
    env: "IRIS_WORKER_STALE_AFTER_MS",
    schema: z.number().int().min(5_000).max(300_000),
    sensitivity: "public",
    default: 45_000,
    restartRequired: true,
  }),
  "operations.workerHeartbeatIntervalMs": define({
    env: "IRIS_WORKER_HEARTBEAT_INTERVAL_MS",
    schema: z.number().int().min(1_000).max(60_000),
    sensitivity: "public",
    default: 10_000,
    restartRequired: true,
  }),
  "operations.workerMaxHeartbeatFailures": define({
    env: "IRIS_WORKER_MAX_CONSECUTIVE_HEARTBEAT_FAILURES",
    schema: z.number().int().min(1).max(20),
    sensitivity: "public",
    default: 3,
    restartRequired: true,
  }),
} satisfies Record<
  SystemSettingKey,
  SystemSettingDefinition<SystemSettingScalar>
>;

export const BOOTSTRAP_SYSTEM_SETTING_KEYS = [
  "POSTGRES_URL",
  "IRIS_ROOT_ENCRYPTION_KEY",
] as const;

export function parseSystemSettingValue(
  key: SystemSettingKey,
  value: unknown,
): SystemSettingScalar {
  return SYSTEM_SETTING_DEFINITIONS[key].schema.parse(value);
}

export function parseSystemSettingMutation(
  mutation: SystemSettingMutation,
): SystemSettingMutation {
  if (mutation.operation === "clear") return mutation;
  return {
    ...mutation,
    value: parseSystemSettingValue(mutation.key, mutation.value),
  };
}

export function toRedactedSystemSettingDto(
  key: SystemSettingKey,
  value: SystemSettingScalar | undefined,
): RedactedSystemSettingDto {
  const definition = SYSTEM_SETTING_DEFINITIONS[key];
  const configured = value !== undefined;
  const secret = definition.sensitivity === "secret";
  return {
    key,
    value: secret ? null : (value ?? definition.default),
    sensitivity: definition.sensitivity,
    configured,
    redacted: secret && configured,
    restartRequired: definition.restartRequired,
  };
}
