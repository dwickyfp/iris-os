import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import "load-env";
import {
  type Evidence,
  evidenceMarkdown,
  sealEvidence,
} from "lib/db/migration-operations/evidence";
import {
  type RolloutPolicy,
  evaluateRolloutGate,
} from "lib/db/migration-operations/gate";
import { migrationInventory } from "lib/db/migration-operations/inventory";
import {
  createBackup,
  flagsOffProbe,
  restoreBackup,
} from "lib/db/migration-operations/rollback";
import {
  migrateAndVerify,
  verifyIntegrity,
} from "lib/db/migration-operations/runner";
import {
  assertDistinctTargets,
  requireSafeTarget,
} from "lib/db/migration-operations/safety";

const operation = process.argv[2];
const outputDirectory = path.resolve(
  process.env.MIGRATION_EVIDENCE_DIR ?? "artifacts/migration-operations",
);

function snapshotBindingHash() {
  return process.env.MIGRATION_SNAPSHOT_RECEIPT
    ? sealEvidence({
        evidenceVersion: 1,
        operation: "snapshot-receipt",
        passed: true,
        receipt: process.env.MIGRATION_SNAPSHOT_RECEIPT,
      }).hash
    : null;
}

async function writeEvidence(evidence: Evidence) {
  const sealed = sealEvidence(evidence);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(outputDirectory, `${evidence.operation}.json`),
      sealed.json,
    ),
    writeFile(
      path.join(outputDirectory, `${evidence.operation}.sha256`),
      `${sealed.hash}\n`,
    ),
    writeFile(
      path.join(outputDirectory, `${evidence.operation}.md`),
      evidenceMarkdown(evidence, sealed.hash),
    ),
  ]);
  console.info(
    `${evidence.operation}: ${evidence.passed ? "PASS" : "FAIL"} ${sealed.hash}`,
  );
  if (!evidence.passed) process.exitCode = 1;
}

async function main() {
  const inventory = await migrationInventory();
  if (operation === "rehearse") {
    const target = requireSafeTarget(process.env);
    const result = await migrateAndVerify(target.connectionString);
    await writeEvidence({
      evidenceVersion: 1,
      operation: "rehearsal",
      passed: result.integrity.passed,
      databaseHash: target.databaseHash,
      durationMs: result.durationMs,
      hazards: inventory.migrations.flatMap((migration) =>
        migration.hazards.map((hazard) => ({
          file: migration.file,
          ...hazard,
        })),
      ),
      integrity: result.integrity,
      migrationSetHash: inventory.migrationSetHash,
      migrations: inventory.migrations,
      snapshotBindingHash: snapshotBindingHash(),
      targetKind: target.kind,
    });
    return;
  }
  if (operation === "integrity") {
    const target = requireSafeTarget(process.env);
    const result = await verifyIntegrity(target.connectionString);
    await writeEvidence({
      evidenceVersion: 1,
      operation: "integrity",
      databaseHash: target.databaseHash,
      migrationSetHash: inventory.migrationSetHash,
      snapshotBindingHash: snapshotBindingHash(),
      ...result,
    });
    return;
  }
  if (operation === "rollback-drill") {
    const source = requireSafeTarget(process.env);
    const restore = requireSafeTarget(process.env, "MIGRATION_RESTORE");
    assertDistinctTargets(source, restore);
    const temporary = await mkdtemp(
      path.join(tmpdir(), "iris-migration-rollback-"),
    );
    const backup =
      process.env.MIGRATION_BACKUP_FILE ?? path.join(temporary, "source.dump");
    try {
      if (process.env.MIGRATION_BACKUP_FILE) await readFile(backup);
      else await createBackup(source, backup);
      await restoreBackup(restore, backup);
      const integrity = await verifyIntegrity(restore.connectionString);
      const flagsOff = flagsOffProbe();
      await writeEvidence({
        evidenceVersion: 1,
        operation: "rollback-drill",
        passed: flagsOff && integrity.passed,
        flagsOffProbe: flagsOff,
        integrity,
        migrationSetHash: inventory.migrationSetHash,
        restoreDatabaseHash: restore.databaseHash,
        snapshotBindingHash: snapshotBindingHash(),
        sourceDatabaseHash: source.databaseHash,
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    return;
  }
  if (operation === "rollout-gate") {
    const policy = process.env.MIGRATION_ROLLOUT_POLICY ?? "disposable";
    if (policy !== "disposable" && policy !== "staging") {
      throw new Error("MIGRATION_ROLLOUT_POLICY must be disposable or staging");
    }
    const result = await evaluateRolloutGate(
      outputDirectory,
      policy as RolloutPolicy,
    );
    await writeEvidence({
      evidenceVersion: 1,
      operation: "rollout-gate",
      ...result,
    });
    return;
  }
  throw new Error(
    "Usage: migration-operations.ts rehearse|integrity|rollback-drill|rollout-gate",
  );
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
