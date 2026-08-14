import "server-only";

import {
  ActivityEventInputSchema,
  type ActivityEventInput,
} from "app-types/activity";
import { pgDb } from "lib/db/pg/db.pg";
import { IrisActivityEventTable } from "lib/db/pg/schema.pg";
import { generateUUID } from "lib/utils";
import { enqueueActivityEvent } from "./queue";
import { sanitizeActivityPayload } from "./sanitize";

export async function recordActivityEvent(
  userId: string,
  raw: ActivityEventInput,
) {
  const input = ActivityEventInputSchema.parse(raw);
  const [event] = await pgDb
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
  void enqueueActivityEvent(event.id);
  return event;
}
