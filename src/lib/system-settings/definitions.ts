import type {
  RedactedSystemSettingDto,
  SystemSettingKey,
  SystemSettingMutation,
  SystemSettingScalar,
  SystemSettingSensitivity,
} from "app-types/system-settings";
import { z } from "zod";

const optionalText = z.string().trim().max(4096).nullable();
const optionalUuid = z.string().uuid().nullable();

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

// Only settings an administrator genuinely edits from the UI live here.
// Everything else is static application config in `src/lib/app-config.ts`.
export const SYSTEM_SETTING_DEFINITIONS = {
  "exa.apiKey": define({
    env: "EXA_API_KEY",
    schema: optionalText,
    sensitivity: "secret",
    default: null,
    restartRequired: false,
  }),
  "mcp.allowUserServers": define({
    env: "NOT_ALLOW_ADD_MCP_SERVERS",
    schema: z.boolean(),
    sensitivity: "public",
    default: true,
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
