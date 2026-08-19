import { drizzle } from "drizzle-orm/node-postgres";
import { runMigrate } from "lib/db/pg/migrate.pg";
import { Pool } from "pg";
import { runIntegrityChecks } from "./integrity";

const lockKey = 0x49524953;

export async function withMigrationDatabase<T>(
  connectionString: string,
  operation: (pool: Pool) => Promise<T>,
) {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query("SET lock_timeout = '5s'");
    await pool.query("SET statement_timeout = '15min'");
    const lock = await pool.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [lockKey],
    );
    if (!lock.rows[0].locked)
      throw new Error("Migration advisory lock is held");
    return await operation(pool);
  } finally {
    await pool
      .query("SELECT pg_advisory_unlock($1)", [lockKey])
      .catch(() => undefined);
    await pool.end();
  }
}

export async function migrateAndVerify(connectionString: string) {
  return withMigrationDatabase(connectionString, async (pool) => {
    const started = process.hrtime.bigint();
    await runMigrate(drizzle(pool));
    const client = await pool.connect();
    try {
      const integrity = await runIntegrityChecks(client);
      return {
        durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
        integrity,
      };
    } finally {
      client.release();
    }
  });
}

export async function verifyIntegrity(connectionString: string) {
  return withMigrationDatabase(connectionString, async (pool) => {
    const client = await pool.connect();
    try {
      return await runIntegrityChecks(client);
    } finally {
      client.release();
    }
  });
}
