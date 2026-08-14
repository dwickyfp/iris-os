import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

type Journal = {
  entries: Array<{ idx: number; when: number; tag: string }>;
};

describe("PostgreSQL migration journal", () => {
  test("uses strictly increasing timestamps in migration order", async () => {
    const journal = JSON.parse(
      await readFile("src/lib/db/migrations/pg/meta/_journal.json", "utf8"),
    ) as Journal;

    for (const [index, entry] of journal.entries.entries()) {
      expect(entry.idx).toBe(index);
      if (index > 0) {
        expect(
          entry.when,
          `${entry.tag} must be newer than its predecessor`,
        ).toBeGreaterThan(journal.entries[index - 1].when);
      }
    }
  });
});
