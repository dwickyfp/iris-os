import { z } from "zod";

export const BootstrapSystemSettingKeySchema = z.enum([
  "POSTGRES_URL",
  "IRIS_ROOT_ENCRYPTION_KEY",
]);

export type BootstrapSystemSettingKey = z.infer<
  typeof BootstrapSystemSettingKeySchema
>;

export const SystemSettingKeySchema = z.enum([
  "exa.apiKey",
  "exa.baseUrl",
  "oauth.github.clientId",
  "oauth.github.clientSecret",
  "oauth.google.clientId",
  "oauth.google.clientSecret",
  "oauth.google.forceAccountSelection",
  "oauth.microsoft.clientId",
  "oauth.microsoft.clientSecret",
  "oauth.microsoft.tenantId",
  "oauth.microsoft.forceAccountSelection",
  "auth.emailSignInEnabled",
  "auth.emailSignUpEnabled",
  "auth.oauthSignUpEnabled",
  "auth.baseUrl",
  "users.defaultRole",
  "features.workspaces",
  "features.learning",
  "features.automation",
  "features.delegation",
  "features.remoteAgents",
  "memory.curatorMode",
  "memory.recallMode",
  "capabilityRouter.threshold",
  "capabilityRouter.topN",
  "capabilityRouter.minScore",
  "capabilityRouter.timeoutMs",
  "capabilityRouter.fallbackHardCap",
  "ai.stepTimeoutMs",
  "mcp.allowUserServers",
  "mcp.maxTotalTimeoutMs",
  "providers.imageProviderId",
  "providers.realtimeProviderId",
  "legacy.modelSettingsEncryptionKey",
  "legacy.remoteAgentEncryptionKey",
  "legacy.remoteAgentEncryptionKeyV1",
  "legacy.remoteAgentEncryptionKeyV2",
  "operations.metricsToken",
  "operations.readyTimeoutMs",
  "operations.queryTimeoutMs",
  "operations.workerRequired",
  "operations.workerStaleAfterMs",
  "operations.workerHeartbeatIntervalMs",
  "operations.workerMaxHeartbeatFailures",
]);

export type SystemSettingKey = z.infer<typeof SystemSettingKeySchema>;

export const SystemSettingSensitivitySchema = z.enum(["public", "secret"]);
export type SystemSettingSensitivity = z.infer<
  typeof SystemSettingSensitivitySchema
>;

export const SystemSettingScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type SystemSettingScalar = z.infer<typeof SystemSettingScalarSchema>;

export const RedactedSystemSettingDtoSchema = z
  .object({
    key: SystemSettingKeySchema,
    value: SystemSettingScalarSchema,
    sensitivity: SystemSettingSensitivitySchema,
    configured: z.boolean(),
    redacted: z.boolean(),
    restartRequired: z.boolean(),
    revision: z.number().int().nonnegative().optional(),
  })
  .superRefine((setting, context) => {
    if (setting.sensitivity === "secret" && setting.value !== null) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Secret setting values must be redacted",
      });
    }
    if (setting.redacted && setting.sensitivity !== "secret") {
      context.addIssue({
        code: "custom",
        path: ["redacted"],
        message: "Only secret settings may be redacted",
      });
    }
  });

export type RedactedSystemSettingDto = z.infer<
  typeof RedactedSystemSettingDtoSchema
>;

export const SetSystemSettingMutationSchema = z.object({
  operation: z.literal("set"),
  key: SystemSettingKeySchema,
  value: SystemSettingScalarSchema,
});

export const ClearSystemSettingMutationSchema = z.object({
  operation: z.literal("clear"),
  key: SystemSettingKeySchema,
});

export const SystemSettingMutationSchema = z.discriminatedUnion("operation", [
  SetSystemSettingMutationSchema,
  ClearSystemSettingMutationSchema,
]);

export type SetSystemSettingMutation = z.infer<
  typeof SetSystemSettingMutationSchema
>;
export type ClearSystemSettingMutation = z.infer<
  typeof ClearSystemSettingMutationSchema
>;
export type SystemSettingMutation = z.infer<typeof SystemSettingMutationSchema>;
