import "server-only";

import { loadOperationsConfig } from "lib/operations/config";
import { getOperationsSnapshot } from "lib/operations/snapshot";

export async function getOperationsDiagnostics() {
  return getOperationsSnapshot(await loadOperationsConfig());
}
