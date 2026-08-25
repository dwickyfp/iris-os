import { join } from "path";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";

export async function assertSandboxRetirementDrained(
  database: NodePgDatabase,
) {
  await database.execute(sql`
    DO $$
    DECLARE
      has_undrained boolean;
      has_charged_at boolean;
    BEGIN
      IF to_regclass('public.sandbox_session') IS NOT NULL THEN
        EXECUTE 'SELECT EXISTS (SELECT 1 FROM sandbox_session WHERE provider_instance_id IS NOT NULL)'
          INTO has_undrained;
        IF has_undrained THEN
          RAISE EXCEPTION 'SANDBOX_DRAIN_REQUIRED: reconcile provider inventory and clear acknowledged provider instance IDs before migration';
        END IF;
      END IF;
      IF to_regclass('public.sandbox_execution') IS NOT NULL THEN
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'sandbox_execution'
            AND column_name = 'charged_at'
        ) INTO has_charged_at;
        IF has_charged_at THEN
          EXECUTE 'SELECT EXISTS (SELECT 1 FROM sandbox_execution WHERE charged_at IS NULL)'
            INTO has_undrained;
        ELSE
          EXECUTE 'SELECT EXISTS (SELECT 1 FROM sandbox_execution)'
            INTO has_undrained;
        END IF;
        IF has_undrained THEN
          RAISE EXCEPTION 'SANDBOX_DRAIN_REQUIRED: settle all sandbox executions before migration';
        END IF;
      END IF;
    END $$;
  `);
}

export const runMigrate = async (database?: NodePgDatabase) => {
  console.log("⏳ Running PostgreSQL migrations...");

  const start = Date.now();
  const migrationDatabase = database ?? (await import("lib/db/pg/db.pg")).pgDb;
  await assertSandboxRetirementDrained(migrationDatabase);
  await migrate(migrationDatabase, {
    migrationsFolder: join(process.cwd(), "src/lib/db/migrations/pg"),
  }).catch((err) => {
    console.error(
      `❌ PostgreSQL migrations failed. check the postgres instance is running.`,
      err.cause,
    );
    throw err;
  });
  const end = Date.now();

  console.log("✅ PostgreSQL migrations completed in", end - start, "ms");
};
