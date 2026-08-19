import "server-only";

import type { ActivityEventInput } from "app-types/activity";
import {
  type ActivityDatabase,
} from "lib/ai/runtime/event-recorder";
import { eventRecorder } from "lib/ai/runtime/event-recorder.server";

export async function insertActivityEvent(
  database: ActivityDatabase,
  userId: string,
  raw: ActivityEventInput,
) {
  return eventRecorder.insert(database, userId, raw);
}

export function publishActivityEvent(eventId: string) {
  eventRecorder.publish(eventId);
}

export async function recordActivityEvent(
  userId: string,
  raw: ActivityEventInput,
) {
  return eventRecorder.record(userId, raw);
}

export async function recordRuntimeActivityEvent(
  userId: string,
  raw: Omit<ActivityEventInput, "idempotencyKey" | "occurrenceId">,
) {
  return eventRecorder.recordRuntime(userId, raw);
}
