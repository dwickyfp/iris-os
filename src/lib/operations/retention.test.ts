import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test, vi } from "vitest";

const dialect = new PgDialect();
function toText(query: Parameters<typeof dialect.sqlToQuery>[0]) {
  return dialect.sqlToQuery(query).sql;
}
import {
  RETENTION_TARGETS,
  buildRetentionDelete,
  retentionCutoff,
  retentionDaysFor,
  runRetentionSweep,
} from "./retention";

const NOW = new Date("2026-09-12T04:00:00Z");

describe("retentionDaysFor", () => {
  test("uses the table default without env override", () => {
    const target = RETENTION_TARGETS.find(
      (t) => t.table === "iris_activity_event",
    )!;
    expect(retentionDaysFor(target, {})).toBe(target.defaultDays);
  });

  test("honors a numeric env override and falls back on invalid input", () => {
    const target = RETENTION_TARGETS.find(
      (t) => t.table === "iris_activity_event",
    )!;
    expect(retentionDaysFor(target, { [target.envVar]: "14" })).toBe(14);
    expect(retentionDaysFor(target, { [target.envVar]: "not-a-number" })).toBe(
      target.defaultDays,
    );
    // Zero or negative disables the target.
    expect(retentionDaysFor(target, { [target.envVar]: "0" })).toBe(0);
  });
});

describe("retentionCutoff", () => {
  test("computes the cutoff from now minus the configured days", () => {
    const target = RETENTION_TARGETS.find(
      (t) => t.table === "memory_retrieval_audit",
    )!;
    expect(retentionCutoff(target, NOW, {})).toEqual(
      new Date(NOW.getTime() - target.defaultDays * 24 * 60 * 60 * 1000),
    );
  });

  test("is disabled (undefined) when days <= 0", () => {
    const target = RETENTION_TARGETS.find((t) => t.table === "task_activity")!;
    expect(
      retentionCutoff(target, NOW, { [target.envVar]: "0" }),
    ).toBeUndefined();
  });
});

describe("buildRetentionDelete", () => {
  test("targets the table column with the cutoff parameter", () => {
    const target = RETENTION_TARGETS.find(
      (t) => t.table === "iris_activity_event",
    )!;
    const text = toText(buildRetentionDelete(target, NOW));
    expect(text).toContain('"iris_activity_event"');
    expect(text).toContain('"created_at"');
  });

  test("adds the extra predicate for terminal durable jobs", () => {
    const target = RETENTION_TARGETS.find((t) => t.table === "durable_job")!;
    const text = toText(buildRetentionDelete(target, NOW));
    expect(text).toContain("status IN ('completed', 'failed', 'cancelled')");
  });
});

describe("runRetentionSweep", () => {
  test("executes one DELETE per enabled target and reports row counts", async () => {
    const executed: string[] = [];
    const db = {
      execute: vi.fn(
        async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
          executed.push(toText(query));
          return { rowCount: 3 };
        },
      ),
    };
    const deleted = await runRetentionSweep(db, NOW, {});
    for (const target of RETENTION_TARGETS) {
      expect(deleted[target.table]).toBe(3);
    }
    expect(executed.length).toBe(RETENTION_TARGETS.length);
    expect(
      executed.some((text) => text.includes("durable_job_completion_outbox")),
    ).toBe(true);
  });

  test("skips targets disabled by env without executing a DELETE", async () => {
    const disableActivity = RETENTION_TARGETS.find(
      (t) => t.table === "iris_activity_event",
    )!.envVar;
    const db = { execute: vi.fn(async () => ({ rowCount: 0 })) };
    const deleted = await runRetentionSweep(db, NOW, {
      [disableActivity]: "0",
    });
    expect(deleted["iris_activity_event"]).toBe(0);
    expect(db.execute).toHaveBeenCalledTimes(RETENTION_TARGETS.length - 1);
  });
});
