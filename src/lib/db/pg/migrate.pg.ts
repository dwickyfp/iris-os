import { join } from "path";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

export const runMigrate = async (database?: NodePgDatabase) => {
  console.log("⏳ Running PostgreSQL migrations...");

  const start = Date.now();
  const migrationDatabase = database ?? (await import("lib/db/pg/db.pg")).pgDb;
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
