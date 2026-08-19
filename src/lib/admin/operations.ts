import "server-only";

import { parseOperationsConfig } from "lib/operations/config";
import { getOperationsSnapshot } from "lib/operations/snapshot";

export async function getOperationsDiagnostics() {
  return getOperationsSnapshot(parseOperationsConfig(process.env));
}
