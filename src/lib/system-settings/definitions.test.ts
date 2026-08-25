import {
  RedactedSystemSettingDtoSchema,
  SystemSettingKeySchema,
  SystemSettingMutationSchema,
} from "app-types/system-settings";
import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_SYSTEM_SETTING_KEYS,
  SYSTEM_SETTING_DEFINITIONS,
  parseSystemSettingMutation,
  parseSystemSettingValue,
  toRedactedSystemSettingDto,
} from "./definitions";

describe("system setting definitions", () => {
  it("exhaustively defines every persisted setting and excludes bootstrap keys", () => {
    expect(Object.keys(SYSTEM_SETTING_DEFINITIONS).sort()).toEqual(
      [...SystemSettingKeySchema.options].sort(),
    );
    expect(BOOTSTRAP_SYSTEM_SETTING_KEYS).toEqual([
      "POSTGRES_URL",
      "IRIS_ROOT_ENCRYPTION_KEY",
    ]);
    expect(SYSTEM_SETTING_DEFINITIONS).not.toHaveProperty("POSTGRES_URL");
    expect(SYSTEM_SETTING_DEFINITIONS).not.toHaveProperty(
      "IRIS_ROOT_ENCRYPTION_KEY",
    );
  });

  it("provides validated defaults for every setting", () => {
    for (const definition of Object.values(SYSTEM_SETTING_DEFINITIONS)) {
      expect(definition.schema.parse(definition.default)).toEqual(
        definition.default,
      );
      expect(typeof definition.restartRequired).toBe("boolean");
    }
  });

  it("validates constrained operational settings and provider references", () => {
    expect(parseSystemSettingValue("memory.curatorMode", "write")).toBe(
      "write",
    );
    expect(() =>
      parseSystemSettingValue("capabilityRouter.minScore", 1.1),
    ).toThrow();
    expect(() =>
      parseSystemSettingValue("ai.stepTimeoutMs", 300_001),
    ).toThrow();
    expect(() =>
      parseSystemSettingValue("providers.imageProviderId", "not-a-uuid"),
    ).toThrow();
  });

  it("validates set values against the selected definition", () => {
    const mutation = SystemSettingMutationSchema.parse({
      operation: "set",
      key: "capabilityRouter.topN",
      value: 24,
    });
    expect(parseSystemSettingMutation(mutation)).toEqual(mutation);
    expect(() =>
      parseSystemSettingMutation({
        operation: "set",
        key: "capabilityRouter.topN",
        value: "24",
      }),
    ).toThrow();
  });

  it("redacts configured secrets while returning public values and defaults", () => {
    const secret = toRedactedSystemSettingDto(
      "oauth.github.clientSecret",
      "do-not-return",
    );
    expect(secret).toMatchObject({
      value: null,
      configured: true,
      redacted: true,
      sensitivity: "secret",
    });
    expect(JSON.stringify(secret)).not.toContain("do-not-return");
    expect(
      toRedactedSystemSettingDto("memory.recallMode", undefined),
    ).toMatchObject({
      value: "keyword",
      configured: false,
      redacted: false,
    });
    expect(RedactedSystemSettingDtoSchema.parse(secret)).toEqual(secret);
  });

  it("rejects DTOs that expose secret values", () => {
    expect(() =>
      RedactedSystemSettingDtoSchema.parse({
        key: "exa.apiKey",
        value: "leaked",
        sensitivity: "secret",
        configured: true,
        redacted: false,
        restartRequired: false,
      }),
    ).toThrow("Secret setting values must be redacted");
  });
});
