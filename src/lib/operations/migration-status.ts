import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";

const migrationsFolder = join(process.cwd(), "src/lib/db/migrations/pg");

export function getExpectedLatestMigration() {
  const latest = readMigrationFiles({ migrationsFolder }).at(-1);
  if (!latest) throw new Error("No Drizzle migrations found");
  return { createdAt: latest.folderMillis, hash: latest.hash };
}

export const DRIZZLE_MIGRATION_READY_SQL = `
SELECT COALESCE((
  SELECT created_at = $1 AND hash = $2
  FROM drizzle.__drizzle_migrations
  ORDER BY created_at DESC, id DESC
  LIMIT 1
), false) AS ready`;
