import { afterEach, describe, expect, test, vi } from "vitest";

const constructed: Array<Record<string, unknown>> = vi.hoisted(() => []);

vi.mock("pg-boss", () => ({
  default: class MockPgBoss {
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      constructed.push(options);
    }
  },
}));

describe("pg-boss shared client", () => {
  const ORIGINAL_URL = process.env.POSTGRES_URL;
  const ORIGINAL_MAX = process.env.PG_BOSS_POOL_MAX;

  afterEach(() => {
    constructed.length = 0;
    if (ORIGINAL_URL === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = ORIGINAL_URL;
    if (ORIGINAL_MAX === undefined) delete process.env.PG_BOSS_POOL_MAX;
    else process.env.PG_BOSS_POOL_MAX = ORIGINAL_MAX;
  });

  test("returns undefined without a connection string", async () => {
    delete process.env.POSTGRES_URL;
    vi.resetModules();
    const { getPgBoss, getStartedPgBoss } = await import("./pg-boss");
    expect(getPgBoss()).toBeUndefined();
    expect(await getStartedPgBoss()).toBeUndefined();
    expect(constructed).toHaveLength(0);
  });

  test("returns one instance per process with an explicit pool size", async () => {
    process.env.POSTGRES_URL = "postgres://test:test@localhost:5432/test";
    process.env.PG_BOSS_POOL_MAX = "3";
    vi.resetModules();
    const { getPgBoss } = await import("./pg-boss");
    const first = getPgBoss();
    const second = getPgBoss();
    expect(first).toBeDefined();
    expect(second).toBe(first);
    // One construction for the whole process, sized from PG_BOSS_POOL_MAX.
    expect(constructed).toHaveLength(1);
    expect(constructed[0].max).toBe(3);
    expect(constructed[0].connectionString).toBe(
      "postgres://test:test@localhost:5432/test",
    );
  });
});
