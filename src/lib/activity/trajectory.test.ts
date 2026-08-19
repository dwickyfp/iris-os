import { describe, expect, test, vi } from "vitest";
import { IrisActivityEventTable } from "lib/db/pg/schema.pg";
import { getRunTrajectory } from "./trajectory";

describe("getRunTrajectory", () => {
  test("uses occurrence sequence as the north-star trajectory order", async () => {
    const orderBy = vi.fn((..._order: unknown[]) => Promise.resolve([]));
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const database = { select: vi.fn(() => ({ from })) };

    await getRunTrajectory(database as never, "user-1", "run-1");

    expect(orderBy).toHaveBeenCalledOnce();
    expect(orderBy.mock.calls[0]).toHaveLength(3);
    const [sequenceOrder] = orderBy.mock.calls[0];
    expect((sequenceOrder as any).queryChunks).toContain(
      IrisActivityEventTable.sequence,
    );
  });
});
