import PgBoss from "pg-boss";

/**
 * Shared per-process pg-boss singleton.
 *
 * Each subsystem previously constructed its own PgBoss instance, which lazily
 * opened its own connection pool (default max 10) per instance and could push
 * a single web process over Postgres' default max_connections. All queue
 * modules and worker scripts must go through this factory so a process holds
 * exactly one boss with one explicitly sized pool.
 */
export const PG_BOSS_POOL_MAX = Number(process.env.PG_BOSS_POOL_MAX ?? 5);

let boss: PgBoss | undefined;
let startPromise: Promise<PgBoss> | undefined;

export function getPgBoss(connectionString = process.env.POSTGRES_URL) {
  if (!connectionString) return undefined;
  boss ??= new PgBoss({
    connectionString,
    max: PG_BOSS_POOL_MAX,
  });
  return boss;
}

/** Returns the started singleton so enqueue paths do not call start() per send. */
export async function getStartedPgBoss(
  connectionString = process.env.POSTGRES_URL,
) {
  const instance = getPgBoss(connectionString);
  if (!instance) return undefined;
  startPromise ??= instance.start();
  await startPromise;
  return instance;
}
