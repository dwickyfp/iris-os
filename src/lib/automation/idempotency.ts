import { createHash } from "node:crypto";

export function automationRunKey(automationId: string, scheduledFor: Date) {
  return createHash("sha256")
    .update(`${automationId}:${scheduledFor.toISOString()}`)
    .digest("hex");
}
