import "server-only";

import { pgDb } from "lib/db/pg/db.pg";
import logger from "logger";
import { generateUUID } from "lib/utils";
import { enqueueActivityEvent } from "lib/activity/queue";
import { sanitizeActivityPayload } from "lib/activity/sanitize";
import { EventRecorder } from "./event-recorder";

export const eventRecorder = new EventRecorder({
  database: pgDb,
  generateId: generateUUID,
  sanitizePayload: (payload) =>
    sanitizeActivityPayload(payload) as Record<string, unknown>,
  publish: enqueueActivityEvent,
  onPublishError: (eventId, error) =>
    logger.warn("Unable to enqueue durable activity event", {
      eventId,
      error: error instanceof Error ? error.message : String(error),
    }),
});
