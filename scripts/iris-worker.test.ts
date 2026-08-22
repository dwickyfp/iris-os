import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("iris worker root budget maintenance", () => {
  test("reconciles expired reservations at startup and periodically", async () => {
    const source = await readFile(
      new URL("./iris-worker.ts", import.meta.url),
      "utf8",
    );

    expect(source.match(/reconcileExpiredReservations\(\)/g)).toHaveLength(2);
    expect(source).toContain("const rootBudgetReaper = setInterval(");
    expect(source).toContain("clearInterval(rootBudgetReaper)");
  });

  test("reconciles stale sandbox executions regardless of provider state", async () => {
    const source = await readFile(
      new URL("./iris-worker.ts", import.meta.url),
      "utf8",
    );

    expect(source.match(/reconcileStaleExecutions\(\)/g)).toHaveLength(2);
    expect(source).toContain("sandboxManager.reconcileStaleExecutions(),");
  });
});
