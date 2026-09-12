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
    const journal = JSON.parse(
      await readFile(
        join(process.cwd(), "src/lib/db/migrations/pg/meta/_journal.json"),
        "utf8",
      ),
    );
    const newest = journal.entries.at(-1);
    const expected = getExpectedLatestMigration();
    const sql = await readFile(
      join(process.cwd(), "src/lib/db/migrations/pg", `${newest.tag}.sql`),
      "utf8",
    );

    expect(expected.hash).toBe(createHash("sha256").update(sql).digest("hex"));
    // The timestamp must come from the newest journal entry, not a hardcode.
    expect(expected.createdAt).toBe(newest.when);
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
    expect(source).toContain("GROUP BY child.depth");
    expect(source).not.toMatch(/histogram|user_id.*jsonb_build_object/i);
  });
});
