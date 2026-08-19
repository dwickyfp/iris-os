import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Evidence, verifyEvidence } from "./evidence";
import { migrationInventory } from "./inventory";

const requiredOperations = ["rehearsal", "integrity", "rollback-drill"];

export type RolloutPolicy = "disposable" | "staging";

export async function evaluateRolloutGate(
  directory: string,
  policy: RolloutPolicy = "disposable",
) {
  const { migrationSetHash } = await migrationInventory();
  const evidence: Evidence[] = [];
  for (const operation of requiredOperations) {
    const raw = await readFile(
      path.join(directory, `${operation}.json`),
      "utf8",
    );
    const hash = (
      await readFile(path.join(directory, `${operation}.sha256`), "utf8")
    ).trim();
    const item = verifyEvidence(raw, hash);
    if (item.evidenceVersion !== 1 || item.operation !== operation) {
      throw new Error(`Invalid ${operation} evidence identity`);
    }
    if (
      typeof item.passed !== "boolean" ||
      typeof item.migrationSetHash !== "string" ||
      (item.snapshotBindingHash !== null &&
        (typeof item.snapshotBindingHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(item.snapshotBindingHash)))
    ) {
      throw new Error(`Invalid ${operation} evidence fields`);
    }
    evidence.push(item);
  }
  const hashes = new Set(evidence.map((item) => item.migrationSetHash));
  const rehearsal = evidence[0];
  const integrity = evidence[1];
  const rollback = evidence[2];
  const evidenceHashesConsistent = hashes.size === 1;
  const migrationSetMatches = evidence.every(
    (item) => item.migrationSetHash === migrationSetHash,
  );
  const databaseHashesMatch =
    typeof rehearsal.databaseHash === "string" &&
    rehearsal.databaseHash === integrity.databaseHash &&
    rehearsal.databaseHash === rollback.sourceDatabaseHash;
  const snapshotBindingsMatch =
    rehearsal.snapshotBindingHash === integrity.snapshotBindingHash &&
    rehearsal.snapshotBindingHash === rollback.snapshotBindingHash;
  const representativeSnapshotPresent =
    policy !== "staging" ||
    (rehearsal.targetKind === "staging-snapshot" &&
      typeof rehearsal.snapshotBindingHash === "string" &&
      rehearsal.snapshotBindingHash.length > 0);
  const passed =
    evidence.every((item) => item.passed) &&
    evidenceHashesConsistent &&
    migrationSetMatches &&
    databaseHashesMatch &&
    snapshotBindingsMatch &&
    representativeSnapshotPresent;
  return {
    databaseHashesMatch,
    evidenceHashesConsistent,
    migrationSetHash,
    migrationSetMatches,
    operations: evidence.map((item) => ({
      operation: item.operation,
      passed: item.passed,
    })),
    passed,
    policy,
    representativeSnapshotPresent,
    snapshotBindingsMatch,
  };
}
