import "server-only";

import {
  ActivityEventInputSchema,
  type ActivityEventInput,
} from "app-types/activity";
import { pgDb } from "lib/db/pg/db.pg";
import { IrisActivityEventTable } from "lib/db/pg/schema.pg";
import logger from "logger";
import { generateUUID } from "lib/utils";
import { enqueueActivityEvent } from "./queue";
import { sanitizeActivityPayload } from "./sanitize";

type ActivityDatabase = Pick<typeof pgDb, "insert">;

export async function insertActivityEvent(
  database: ActivityDatabase,
  userId: string,
  raw: ActivityEventInput,
) {
  const input = ActivityEventInputSchema.parse(raw);
  const [event] = await database
    .insert(IrisActivityEventTable)
    .values({
      ...input,
      id: input.id ?? generateUUID(),
      userId,
      scopeId: input.scopeId ?? null,
      payload: sanitizeActivityPayload(input.payload) as Record<
        string,
        unknown
      >,
    })
    .onConflictDoUpdate({
      target: [
        IrisActivityEventTable.userId,
        IrisActivityEventTable.idempotencyKey,
      ],
      set: { idempotencyKey: input.idempotencyKey },
    })
    .returning();
  return event;
}

export function publishActivityEvent(eventId: string) {
  void enqueueActivityEvent(eventId).catch((error) =>
    logger.warn("Unable to enqueue durable activity event", {
      eventId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

export async function recordActivityEvent(
  userId: string,
  raw: ActivityEventInput,
) {
  const event = await insertActivityEvent(pgDb, userId, raw);
  publishActivityEvent(event.id);
  return event;
}
