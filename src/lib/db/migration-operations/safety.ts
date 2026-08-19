import { createHash } from "node:crypto";

export type MigrationTargetKind = "disposable" | "staging-snapshot";

const productionName = /(^|[^a-z0-9])(prod|production|live)([^a-z0-9]|$)/i;
const deniedHosts = new Set(["prod", "production", "live"]);

export type SafeTarget = {
  connectionString: string;
  database: string;
  databaseHash: string;
  endpoint: string;
  kind: MigrationTargetKind;
};

export function databaseName(connectionString: string) {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("Migration database URL is invalid");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Migration database URL must use PostgreSQL");
  }
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!name || name.includes("/")) {
    throw new Error("Migration database URL must name exactly one database");
  }
  return { host: url.hostname.toLowerCase(), name };
}

export function requireSafeTarget(
  env: Record<string, string | undefined>,
  prefix = "MIGRATION",
): SafeTarget {
  const connectionString = env[`${prefix}_DATABASE_URL`];
  if (!connectionString) {
    throw new Error(
      `${prefix}_DATABASE_URL is required; POSTGRES_URL is never used`,
    );
  }
  const kind = env[`${prefix}_TARGET_KIND`];
  if (kind !== "disposable" && kind !== "staging-snapshot") {
    throw new Error(
      `${prefix}_TARGET_KIND must be disposable or staging-snapshot`,
    );
  }
  const { host, name } = databaseName(connectionString);
  if (env[`${prefix}_CONFIRM_DATABASE`] !== name) {
    throw new Error(`${prefix}_CONFIRM_DATABASE must exactly equal ${name}`);
  }
  const denylist = new Set(
    (env.MIGRATION_DATABASE_DENYLIST ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (
    productionName.test(name) ||
    productionName.test(host) ||
    deniedHosts.has(host) ||
    denylist.has(name.toLowerCase()) ||
    denylist.has(host)
  ) {
    throw new Error("Production-like or denylisted migration target rejected");
  }
  if (kind === "staging-snapshot" && !env.MIGRATION_SNAPSHOT_RECEIPT?.trim()) {
    throw new Error(
      "MIGRATION_SNAPSHOT_RECEIPT is required for staging-snapshot",
    );
  }
  const endpoint = `${host}:${new URL(connectionString).port || "5432"}/${name}`;
  return {
    connectionString,
    database: name,
    databaseHash: createHash("sha256").update(endpoint).digest("hex"),
    endpoint,
    kind,
  };
}

export function assertDistinctTargets(source: SafeTarget, restore: SafeTarget) {
  if (restore.kind !== "disposable") {
    throw new Error("Rollback restore target must be disposable");
  }
  if (source.endpoint === restore.endpoint) {
    throw new Error("Rollback restore target must be a second database");
  }
}
