import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Evidence, sealEvidence } from "./evidence";
import { evaluateRolloutGate } from "./gate";
import { migrationInventory } from "./inventory";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function evidence(
  operation: string,
  passed = true,
  overrides: Record<string, unknown> = {},
) {
  const { migrationSetHash } = await migrationInventory();
  const value: Evidence = {
    evidenceVersion: 1,
    operation,
    passed,
    migrationSetHash,
    ...(operation === "rollback-drill"
      ? { sourceDatabaseHash: "database" }
      : { databaseHash: "database" }),
    snapshotBindingHash: null,
    ...overrides,
  };
  const sealed = sealEvidence(value);
  await writeFile(path.join(directory!, `${operation}.json`), sealed.json);
  await writeFile(path.join(directory!, `${operation}.sha256`), sealed.hash);
}

describe("migration rollout gate", () => {
  const snapshotA = "a".repeat(64);
  const snapshotB = "b".repeat(64);

  it("passes only complete, passing evidence for one migration set", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "migration-gate-"));
    await Promise.all([
      evidence("rehearsal"),
      evidence("integrity"),
      evidence("rollback-drill"),
    ]);
    expect((await evaluateRolloutGate(directory)).passed).toBe(true);
  });

  it("has no force route for failed evidence", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "migration-gate-"));
    await Promise.all([
      evidence("rehearsal"),
      evidence("integrity", false),
      evidence("rollback-drill"),
    ]);
    expect((await evaluateRolloutGate(directory)).passed).toBe(false);
  });

  it("rejects evidence stored under the wrong operation", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "migration-gate-"));
    await Promise.all([
      evidence("rehearsal"),
      evidence("integrity"),
      evidence("rollback-drill"),
    ]);
    const { migrationSetHash } = await migrationInventory();
    const wrong = sealEvidence({
      evidenceVersion: 1,
      operation: "rehearsal",
      passed: true,
      databaseHash: "database",
      migrationSetHash,
    });
    await writeFile(path.join(directory, "integrity.json"), wrong.json);
    await writeFile(path.join(directory, "integrity.sha256"), wrong.hash);
    await expect(evaluateRolloutGate(directory)).rejects.toThrow(/identity/);
  });

  it("rejects legacy evidence without explicit snapshot binding", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "migration-gate-"));
    await Promise.all([
      evidence("rehearsal"),
      evidence("integrity"),
      evidence("rollback-drill"),
    ]);
    const { migrationSetHash } = await migrationInventory();
    const legacy = sealEvidence({
      evidenceVersion: 1,
      operation: "integrity",
      passed: true,
      databaseHash: "database",
      migrationSetHash,
    });
    await writeFile(path.join(directory, "integrity.json"), legacy.json);
    await writeFile(path.join(directory, "integrity.sha256"), legacy.hash);

    await expect(evaluateRolloutGate(directory)).rejects.toThrow(/fields/);
  });

  it("rejects evidence for a stale migration set", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "migration-gate-"));
    await Promise.all([
      evidence("rehearsal", true, { migrationSetHash: "stale" }),
      evidence("integrity", true, { migrationSetHash: "stale" }),
      evidence("rollback-drill", true, { migrationSetHash: "stale" }),
    ]);

    const result = await evaluateRolloutGate(directory);
    expect(result.migrationSetMatches).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("rejects evidence produced from different databases", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "migration-gate-"));
    await Promise.all([
      evidence("rehearsal"),
      evidence("integrity", true, { databaseHash: "other-database" }),
      evidence("rollback-drill"),
    ]);

    const result = await evaluateRolloutGate(directory);
    expect(result.databaseHashesMatch).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("requires representative snapshot evidence for staging", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "migration-gate-"));
    await Promise.all([
      evidence("rehearsal", true, { targetKind: "staging-snapshot" }),
      evidence("integrity"),
      evidence("rollback-drill"),
    ]);
    expect((await evaluateRolloutGate(directory, "staging")).passed).toBe(
      false,
    );

    await evidence("rehearsal", true, {
      snapshotBindingHash: snapshotA,
      targetKind: "staging-snapshot",
    });
    expect((await evaluateRolloutGate(directory, "staging")).passed).toBe(false);

    await Promise.all([
      evidence("integrity", true, { snapshotBindingHash: snapshotA }),
      evidence("rollback-drill", true, {
        snapshotBindingHash: snapshotA,
      }),
    ]);
    expect((await evaluateRolloutGate(directory, "staging")).passed).toBe(true);
  });

  it("rejects evidence bound to different source snapshots", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "migration-gate-"));
    await Promise.all([
      evidence("rehearsal", true, { snapshotBindingHash: snapshotA }),
      evidence("integrity", true, { snapshotBindingHash: snapshotB }),
      evidence("rollback-drill", true, {
        snapshotBindingHash: snapshotA,
      }),
    ]);

    const result = await evaluateRolloutGate(directory);
    expect(result.snapshotBindingsMatch).toBe(false);
    expect(result.passed).toBe(false);
  });
});
