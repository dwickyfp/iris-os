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
  "mcp.allowUserServers",
  "providers.imageProviderId",
  "providers.realtimeProviderId",
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
