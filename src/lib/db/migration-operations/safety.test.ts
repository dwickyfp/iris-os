import { describe, expect, it } from "vitest";
import { assertDistinctTargets, requireSafeTarget } from "./safety";

const base = {
  MIGRATION_DATABASE_URL:
    "postgresql://user:secret@localhost:5432/iris_rehearsal",
  MIGRATION_TARGET_KIND: "disposable",
  MIGRATION_CONFIRM_DATABASE: "iris_rehearsal",
};

describe("migration target safety", () => {
  it("requires a dedicated URL and never falls back", () => {
    expect(() =>
      requireSafeTarget({ POSTGRES_URL: base.MIGRATION_DATABASE_URL }),
    ).toThrow(/MIGRATION_DATABASE_URL is required/);
  });

  it("requires exact confirmation and rejects production-like names", () => {
    expect(() =>
      requireSafeTarget({ ...base, MIGRATION_CONFIRM_DATABASE: "other" }),
    ).toThrow(/exactly equal/);
    expect(() =>
      requireSafeTarget({
        ...base,
        MIGRATION_DATABASE_URL: "postgresql://user:x@localhost/iris-production",
        MIGRATION_CONFIRM_DATABASE: "iris-production",
      }),
    ).toThrow(/Production-like/);
  });

  it("requires a snapshot receipt and a distinct disposable restore", () => {
    expect(() =>
      requireSafeTarget({ ...base, MIGRATION_TARGET_KIND: "staging-snapshot" }),
    ).toThrow(/SNAPSHOT_RECEIPT/);
    const source = requireSafeTarget(base);
    const sameDatabase = requireSafeTarget({
      ...base,
      MIGRATION_DATABASE_URL:
        "postgresql://different:credentials@localhost:5432/iris_rehearsal",
    });
    expect(() => assertDistinctTargets(source, sameDatabase)).toThrow(
      /second database/,
    );
  });

  it("binds database evidence to the credential-free endpoint", () => {
    const local = requireSafeTarget(base);
    const otherHost = requireSafeTarget({
      ...base,
      MIGRATION_DATABASE_URL:
        "postgresql://user:secret@snapshot.internal:5432/iris_rehearsal",
    });

    expect(local.databaseHash).not.toBe(otherHost.databaseHash);
  });
});
