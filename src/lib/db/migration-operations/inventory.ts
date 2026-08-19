import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const migrationDirectory = path.join(process.cwd(), "src/lib/db/migrations/pg");

const hazardPatterns = [
  ["table-rewrite", /\bALTER\s+TABLE\b[^;]*\bALTER\s+COLUMN\b[^;]*\bTYPE\b/gi],
  ["blocking-index", /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b(?!\s+CONCURRENTLY)/gi],
  ["destructive-drop", /\bDROP\s+(?:TABLE|COLUMN|TYPE|SCHEMA)\b/gi],
  ["non-null", /\bSET\s+NOT\s+NULL\b|\bADD\s+COLUMN\b[^;]*\bNOT\s+NULL\b/gi],
  ["data-rewrite", /\b(?:UPDATE|DELETE\s+FROM)\b/gi],
] as const;

export async function migrationInventory() {
  const files = (await readdir(migrationDirectory))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
  const migrations = await Promise.all(
    files.map(async (file) => {
      const sql = await readFile(path.join(migrationDirectory, file), "utf8");
      const hazards = hazardPatterns.flatMap(([kind, pattern]) => {
        pattern.lastIndex = 0;
        return [...sql.matchAll(pattern)].map((match) => ({
          kind,
          offset: match.index,
        }));
      });
      return {
        file,
        hazards,
        sha256: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
  return {
    migrations,
    migrationSetHash: createHash("sha256")
      .update(
        migrations.map(({ file, sha256 }) => `${file}:${sha256}`).join("\n"),
      )
      .digest("hex"),
  };
}
