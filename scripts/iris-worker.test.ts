import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("iris worker maintenance", () => {
  test("reconciles expired reservations at startup and periodically", async () => {
    const source = await readFile(
      new URL("./iris-worker.ts", import.meta.url),
      "utf8",
    );

    expect(source.match(/reconcileExpiredReservations\(\)/g)).toHaveLength(2);
    expect(source).toContain("const rootBudgetReaper = setInterval(");
    expect(source).toContain("clearInterval(rootBudgetReaper)");
  });

  test("reaps artifact cleanup jobs periodically", async () => {
    const source = await readFile(
      new URL("./iris-worker.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("const artifactCleanupReaper = setInterval(");
    expect(source).toContain("clearInterval(artifactCleanupReaper)");
    expect(source).toContain(".reapCleanup()");
  });
});
