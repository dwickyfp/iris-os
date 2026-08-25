import "server-only";

import { and, desc, eq } from "drizzle-orm";
import type {
  StoredSystemSetting,
  SystemSettingsRepository,
} from "lib/system-settings/service";
import { pgDb as db } from "../db.pg";
import { SystemSettingAuditTable, SystemSettingTable } from "../schema.pg";

function toStoredSetting(
  row: typeof SystemSettingTable.$inferSelect,
): StoredSystemSetting {
  return {
    ...row,
    key: row.key as StoredSystemSetting["key"],
    valueKind: row.valueKind as StoredSystemSetting["valueKind"],
    value: row.value as StoredSystemSetting["value"],
  };
}

export const pgSystemSettingsRepository: SystemSettingsRepository = {
  async list() {
    const rows = await db
      .select({
        key: SystemSettingTable.key,
        valueKind: SystemSettingTable.valueKind,
        value: SystemSettingTable.value,
        encryptionKeyId: SystemSettingTable.encryptionKeyId,
        revision: SystemSettingTable.revision,
        createdBy: SystemSettingTable.createdBy,
        updatedBy: SystemSettingTable.updatedBy,
        createdAt: SystemSettingTable.createdAt,
        updatedAt: SystemSettingTable.updatedAt,
        rotatedAt: SystemSettingTable.rotatedAt,
      })
      .from(SystemSettingTable);
    return rows.map((row) =>
      toStoredSetting({
        ...row,
        encryptedValue: row.encryptionKeyId ? "configured" : null,
      } as typeof SystemSettingTable.$inferSelect),
    );
  },

  async selectByKey(key) {
    const [row] = await db
      .select()
      .from(SystemSettingTable)
      .where(eq(SystemSettingTable.key, key));
    return row ? toStoredSetting(row) : null;
  },

  async mutate(input) {
    return db.transaction(async (tx) => {
      const nextRevision = input.expectedRevision + 1;
      let setting: typeof SystemSettingTable.$inferSelect | undefined;

      if (input.mutation.operation === "clear") {
        const [deleted] = await tx
          .delete(SystemSettingTable)
          .where(
            and(
              eq(SystemSettingTable.key, input.mutation.key),
              eq(SystemSettingTable.revision, input.expectedRevision),
            ),
          )
          .returning();
        if (!deleted) return null;
      } else if (input.expectedRevision === 0) {
        [setting] = await tx
          .insert(SystemSettingTable)
          .values({
            key: input.mutation.key,
            valueKind: input.valueKind,
            value: input.value,
            encryptedValue: input.encryptedValue,
            encryptionKeyId: input.encryptionKeyId,
            revision: nextRevision,
            createdBy: input.actorId,
            updatedBy: input.actorId,
            rotatedAt: input.encryptedValue ? new Date() : null,
          })
          .onConflictDoNothing({ target: SystemSettingTable.key })
          .returning();
        if (!setting) return null;
      } else {
        [setting] = await tx
          .update(SystemSettingTable)
          .set({
            valueKind: input.valueKind,
            value: input.value,
            encryptedValue: input.encryptedValue,
            encryptionKeyId: input.encryptionKeyId,
            revision: nextRevision,
            updatedBy: input.actorId,
            updatedAt: new Date(),
            ...(input.encryptedValue ? { rotatedAt: new Date() } : {}),
          })
          .where(
            and(
              eq(SystemSettingTable.key, input.mutation.key),
              eq(SystemSettingTable.revision, input.expectedRevision),
            ),
          )
          .returning();
        if (!setting) return null;
      }

      await tx.insert(SystemSettingAuditTable).values({
        key: input.mutation.key,
        operation: input.mutation.operation,
        valueKind: input.valueKind,
        revision: nextRevision,
        actorId: input.actorId,
      });
      return {
        setting: setting ? toStoredSetting(setting) : null,
        revision: nextRevision,
      };
    });
  },

  async listAudit(input = {}) {
    const rows = await db
      .select({
        id: SystemSettingAuditTable.id,
        key: SystemSettingAuditTable.key,
        operation: SystemSettingAuditTable.operation,
        valueKind: SystemSettingAuditTable.valueKind,
        revision: SystemSettingAuditTable.revision,
        actorId: SystemSettingAuditTable.actorId,
        createdAt: SystemSettingAuditTable.createdAt,
      })
      .from(SystemSettingAuditTable)
      .where(input.key ? eq(SystemSettingAuditTable.key, input.key) : undefined)
      .orderBy(desc(SystemSettingAuditTable.createdAt))
      .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
    return rows.map((row) => ({
      ...row,
      key: row.key as StoredSystemSetting["key"],
      operation: row.operation as "set" | "clear",
      valueKind: row.valueKind as "plain" | "secret",
    }));
  },
};
