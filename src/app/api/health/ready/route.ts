import { loadOperationsConfig, type OperationsConfig } from "lib/operations/config";
import {
  evaluateReadiness,
  unavailableReadiness,
} from "lib/operations/readiness";
import {
  getOperationsMigrationStatus,
  getOperationsSnapshot,
} from "lib/operations/snapshot";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = await loadOperationsConfig();
    const result = await Promise.race([
      getSnapshotAfterMigrationCheck(config),
      timeout(config.OPERATIONS_READY_TIMEOUT_MS),
    ]);
    if (!result) {
      const unavailable = unavailableReadiness("database");
      unavailable.checks.database = { ok: true };
      unavailable.checks.migrations = {
        ok: false,
        detail: "migration pending",
      };
      return response(unavailable, 503);
    }
    const readiness = evaluateReadiness(config, result);
    return response(readiness, readiness.status === "ready" ? 200 : 503);
  } catch {
    return response(unavailableReadiness("database"), 503);
  }
}

async function getSnapshotAfterMigrationCheck(
  config: OperationsConfig,
) {
  if (!(await getOperationsMigrationStatus(config))) return null;
  return getOperationsSnapshot(config);
}

function response(body: unknown, status: number) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Readiness deadline exceeded")), ms),
  );
}
