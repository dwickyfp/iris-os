import "server-only";

import type {
  RedactedSystemSettingDto,
  SystemSettingKey,
  SystemSettingMutation,
  SystemSettingScalar,
} from "app-types/system-settings";
import { SystemSettingKeySchema } from "app-types/system-settings";
import {
  decryptSystemSettingValue,
  encryptSystemSettingValue,
} from "lib/security/encrypted-value";
import {
  SYSTEM_SETTING_DEFINITIONS,
  parseSystemSettingMutation,
  parseSystemSettingValue,
  toRedactedSystemSettingDto,
} from "./definitions";

export const SYSTEM_SETTING_ENCRYPTION_KEY_ID = "root-v1";

export type StoredSystemSetting = {
  key: SystemSettingKey;
  valueKind: "plain" | "secret";
  value: SystemSettingScalar | null;
  encryptedValue: string | null;
  encryptionKeyId: string | null;
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
  rotatedAt: Date | null;
};

export type SystemSettingAudit = {
  id: string;
  key: SystemSettingKey;
  operation: "set" | "clear";
  valueKind: "plain" | "secret";
  revision: number;
  actorId: string;
  createdAt: Date;
};

export type PersistedSystemSettingMutation = {
  mutation: SystemSettingMutation;
  valueKind: "plain" | "secret";
  value: SystemSettingScalar | null;
  encryptedValue: string | null;
  encryptionKeyId: string | null;
  actorId: string;
  expectedRevision: number;
};

export type PersistedSystemSettingMutationResult = {
  setting: StoredSystemSetting | null;
  revision: number;
};

export interface SystemSettingsRepository {
  list(): Promise<StoredSystemSetting[]>;
  selectByKey(key: SystemSettingKey): Promise<StoredSystemSetting | null>;
  mutate(
    input: PersistedSystemSettingMutation,
  ): Promise<PersistedSystemSettingMutationResult | null>;
  listAudit(input?: {
    key?: SystemSettingKey;
    limit?: number;
  }): Promise<SystemSettingAudit[]>;
}

export class SystemSettingRevisionConflictError extends Error {
  constructor() {
    super("System setting was changed by another administrator");
    this.name = "SystemSettingRevisionConflictError";
  }
}

export type SystemSettingDto = RedactedSystemSettingDto & {
  revision: number;
};

function readStoredValue(row: StoredSystemSetting): SystemSettingScalar {
  if (row.valueKind === "plain") {
    return parseSystemSettingValue(row.key, row.value);
  }
  if (!row.encryptedValue) {
    throw new Error(`Encrypted value is missing for ${row.key}`);
  }
  const plaintext = decryptSystemSettingValue(row.key, row.encryptedValue);
  return parseSystemSettingValue(row.key, JSON.parse(plaintext));
}

export function createSystemSettingsService(
  repository: SystemSettingsRepository,
) {
  return {
    async list(): Promise<SystemSettingDto[]> {
      const rows = new Map(
        (await repository.list()).map((row) => [row.key, row]),
      );
      return SystemSettingKeySchema.options.map((key) => {
        const row = rows.get(key);
        const value = row
          ? row.valueKind === "plain"
            ? readStoredValue(row)
            : "configured-secret"
          : undefined;
        return {
          ...toRedactedSystemSettingDto(key, value),
          revision: row?.revision ?? 0,
        };
      });
    },

    async getPlain(key: SystemSettingKey): Promise<SystemSettingScalar> {
      const definition = SYSTEM_SETTING_DEFINITIONS[key];
      if (definition.sensitivity !== "public") {
        throw new Error(`${key} is a secret system setting`);
      }
      const row = await repository.selectByKey(key);
      if (row) return readStoredValue(row);
      return definition.default;
    },

    async getSecret(key: SystemSettingKey): Promise<string | null> {
      const definition = SYSTEM_SETTING_DEFINITIONS[key];
      if (definition.sensitivity !== "secret") {
        throw new Error(`${key} is not a secret system setting`);
      }
      const row = await repository.selectByKey(key);
      if (!row) return definition.default as string | null;
      const value = readStoredValue(row);
      if (value !== null && typeof value !== "string") {
        throw new Error(`${key} does not contain a string secret`);
      }
      return value;
    },

    async mutate(
      mutation: SystemSettingMutation,
      actorId: string,
      expectedRevision: number,
    ): Promise<SystemSettingDto> {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error("Expected revision must be a non-negative integer");
      }
      const parsed = parseSystemSettingMutation(mutation);
      const definition = SYSTEM_SETTING_DEFINITIONS[parsed.key];
      const secret = definition.sensitivity === "secret";
      const value = parsed.operation === "set" ? parsed.value : null;
      const encryptedValue =
        parsed.operation === "set" && secret
          ? encryptSystemSettingValue(parsed.key, JSON.stringify(value))
          : null;
      const result = await repository.mutate({
        mutation: parsed,
        valueKind: secret ? "secret" : "plain",
        value: secret ? null : value,
        encryptedValue,
        encryptionKeyId: encryptedValue
          ? SYSTEM_SETTING_ENCRYPTION_KEY_ID
          : null,
        actorId,
        expectedRevision,
      });
      if (!result) throw new SystemSettingRevisionConflictError();
      if (parsed.operation === "clear") {
        return {
          ...toRedactedSystemSettingDto(parsed.key, undefined),
          revision: result.revision,
        };
      }
      if (!result.setting) throw new Error("System setting mutation failed");
      return {
        ...toRedactedSystemSettingDto(
          parsed.key,
          secret ? value : result.setting.value,
        ),
        revision: result.revision,
      };
    },

    listAudit(input?: { key?: SystemSettingKey; limit?: number }) {
      return repository.listAudit(input);
    },
  };
}
