import {
  ActivityEventInputSchema,
  type ActivityEventInput,
} from "app-types/activity";
import { IrisActivityEventTable } from "lib/db/pg/schema.pg";

export type ActivityDatabase = {
  insert: (table: typeof IrisActivityEventTable) => any;
};

export type EventRecorderDependencies = {
  database: ActivityDatabase;
  generateId(): string;
  sanitizePayload(payload: Record<string, unknown>): Record<string, unknown>;
  publish(eventId: string): Promise<unknown>;
  onPublishError(eventId: string, error: unknown): void;
};

export class EventRecorder {
  constructor(private readonly dependencies: EventRecorderDependencies) {}

  async insert(
    database: ActivityDatabase,
    userId: string,
    raw: ActivityEventInput,
  ) {
    const input = ActivityEventInputSchema.parse(raw);
    const [event] = await database
      .insert(IrisActivityEventTable)
      .values({
        ...input,
        id: input.id ?? this.dependencies.generateId(),
        userId,
        scopeId: input.scopeId ?? null,
        payload: this.dependencies.sanitizePayload(input.payload),
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

  publish(eventId: string) {
    void this.dependencies
      .publish(eventId)
      .catch((error) => this.dependencies.onPublishError(eventId, error));
  }

  async record(userId: string, raw: ActivityEventInput) {
    const event = await this.insert(this.dependencies.database, userId, raw);
    this.publish(event.id);
    return event;
  }

  async recordRuntime(
    userId: string,
    raw: Omit<ActivityEventInput, "idempotencyKey" | "occurrenceId">,
  ) {
    if (!raw.runId) throw new Error("RUNTIME_EVENT_RUN_ID_REQUIRED");
    const occurrenceId = this.dependencies.generateId();
    return this.record(userId, {
      ...raw,
      id: occurrenceId,
      occurrenceId,
      idempotencyKey: `runtime:${occurrenceId}`,
    });
  }
}
