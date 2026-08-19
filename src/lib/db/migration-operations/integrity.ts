import type { PoolClient } from "pg";

type Check = { name: string; sql: string; tables: string[] };
type CheckResult = {
  name: string;
  status: "failed" | "not-applicable" | "passed";
  violations: number;
};

const checks: Check[] = [
  {
    name: "invalid-memory-scope-pairs",
    tables: ["user_memory"],
    sql: `SELECT count(*)::int AS violations FROM user_memory
      WHERE (scope_type = 'global' AND scope_id IS NOT NULL)
         OR (scope_type <> 'global' AND scope_id IS NULL)`,
  },
  {
    name: "orphan-memory-evidence",
    tables: ["memory_evidence", "user_memory"],
    sql: `SELECT count(*)::int AS violations FROM memory_evidence evidence
      LEFT JOIN user_memory memory ON memory.id = evidence.memory_id
      WHERE memory.id IS NULL`,
  },
  {
    name: "cross-owner-memory-edges",
    tables: ["memory_edge", "user_memory"],
    sql: `SELECT count(*)::int AS violations FROM memory_edge edge
      JOIN user_memory memory ON memory.id = edge.source_id
      WHERE edge.source_type = 'claim' AND edge.user_id <> memory.user_id`,
  },
  {
    name: "invalid-artifact-verification",
    tables: ["artifact_verification"],
    sql: `SELECT count(*)::int AS violations FROM artifact_verification
      WHERE (verified AND details IS NULL) OR (NOT verified AND reason IS NULL)`,
  },
  {
    name: "unowned-artifacts",
    tables: ["artifact"],
    sql: `SELECT count(*)::int AS violations FROM artifact
      WHERE user_id IS NULL OR run_id IS NULL`,
  },
];

export async function runIntegrityChecks(client: PoolClient) {
  await client.query("BEGIN READ ONLY");
  try {
    const tableRows = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tables = new Set(tableRows.rows.map((row) => row.table_name));
    const results: CheckResult[] = [];
    const invalidConstraints = await client.query<{ violations: number }>(
      `SELECT count(*)::int AS violations FROM pg_constraint constraint_row
       JOIN pg_namespace namespace_row
         ON namespace_row.oid = constraint_row.connamespace
       WHERE namespace_row.nspname = 'public' AND NOT constraint_row.convalidated`,
    );
    results.push({
      name: "unvalidated-constraints",
      status: invalidConstraints.rows[0].violations === 0 ? "passed" : "failed",
      violations: invalidConstraints.rows[0].violations,
    });
    for (const check of checks) {
      if (!check.tables.every((table) => tables.has(table))) {
        results.push({
          name: check.name,
          status: "not-applicable",
          violations: 0,
        });
        continue;
      }
      const result = await client.query<{ violations: number }>(check.sql);
      results.push({
        name: check.name,
        status: result.rows[0].violations === 0 ? "passed" : "failed",
        violations: result.rows[0].violations,
      });
    }
    const counts = await client.query<{ rows: number; table_name: string }>(
      `SELECT relname AS table_name, n_live_tup::bigint::int AS rows
       FROM pg_stat_user_tables ORDER BY relname`,
    );
    await client.query("COMMIT");
    return {
      checks: results,
      passed: results.every((result) => result.violations === 0),
      rowCounts: counts.rows,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
