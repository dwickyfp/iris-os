import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DRIZZLE_MIGRATION_READY_SQL,
  getExpectedLatestMigration,
} from "./migration-status";

describe("operations migration readiness", () => {
  it("derives the expected timestamp and hash from the latest Drizzle migration", async () => {
    const expected = getExpectedLatestMigration();
    const sql = await readFile(
      join(
        process.cwd(),
        "src/lib/db/migrations/pg/0062_automation_authority_snapshot.sql",
      ),
      "utf8",
    );

    expect(expected).toEqual({
      createdAt: 1787475600000,
      hash: createHash("sha256").update(sql).digest("hex"),
    });
  });

  it("checks the latest journal row against both expected fields", () => {
    expect(DRIZZLE_MIGRATION_READY_SQL).toContain("created_at = $1");
    expect(DRIZZLE_MIGRATION_READY_SQL).toContain("hash = $2");
    expect(DRIZZLE_MIGRATION_READY_SQL).toContain(
      "ORDER BY created_at DESC, id DESC",
    );
  });

  it("derives bounded operational dimensions from durable state", async () => {
    const source = await readFile(
      join(process.cwd(), "src/lib/operations/snapshot.ts"),
      "utf8",
    );
    expect(source).toContain("status = 'budget_exhausted' AND depth = 0");
    expect(source).toContain("settled_at >= expires_at");
    expect(source).toContain(
      "error_code IN ('SANDBOX_TIMED_OUT', 'SANDBOX_SESSION_LOST')",
    );
    expect(source).toContain("GROUP BY child.depth");
    expect(source).toContain("FROM sandbox_execution GROUP BY status");
    expect(source).toContain("event_type = 'sandbox.session_reaped'");
    expect(source).not.toContain(
      "'forcedDestroy', (SELECT count(*) FROM iris_activity_event",
    );
    expect(source).toContain("error_code LIKE 'SANDBOX_ARTIFACT_%'");
    expect(source).not.toMatch(/histogram|user_id.*jsonb_build_object/i);
  });
});
