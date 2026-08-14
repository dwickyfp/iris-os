import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "pg";

const migrationsDir = path.join(process.cwd(), "src/lib/db/migrations/pg");

export async function migrationFiles() {
  return (await readdir(migrationsDir))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
}

export async function applyMigrations(
  client: Client,
  options: { after?: string; through?: string } = {},
) {
  const files = await migrationFiles();
  const selected = files.filter(
    (file) =>
      (!options.after || file > options.after) &&
      (!options.through || file <= options.through),
  );
  for (const file of selected) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await client.query("BEGIN");
    try {
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.query(statement);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed`, { cause: error });
    }
  }
  return selected;
}

export async function recreatePublicSchema(client: Client) {
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
}
