import { describe, expect, test, vi } from "vitest";
import { EventRecorder } from "./event-recorder";

function activityInput() {
  return {
    actorType: "system" as const,
    eventType: "trajectory.started" as const,
    subjectType: "trajectory",
    payload: { message: "start", secret: "removed" },
    idempotencyKey: "trajectory.started:run-1",
  };
}

describe("EventRecorder", () => {
  test("inserts with the supplied transaction without publishing", async () => {
    const order: string[] = [];
    const returning = vi.fn(async () => {
      order.push("inserted");
      return [{ id: "event-1" }];
    });
    const onConflictDoUpdate = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const transaction = { insert: vi.fn(() => ({ values })) };
    const publish = vi.fn(async () => order.push("published"));
    const recorder = new EventRecorder({
      database: {} as never,
      generateId: () => "generated-id",
      sanitizePayload: ({ secret: _secret, ...payload }) => payload,
      publish,
      onPublishError: vi.fn(),
    });

    await expect(
      recorder.insert(transaction as never, "user-1", activityInput()),
    ).resolves.toEqual({ id: "event-1" });

    expect(transaction.insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "generated-id",
        userId: "user-1",
        scopeId: null,
        payload: { message: "start" },
      }),
    );
    expect(publish).not.toHaveBeenCalled();
    expect(order).toEqual(["inserted"]);
  });

  test("record publishes only after the insert resolves", async () => {
    const order: string[] = [];
    const returning = vi.fn(async () => {
      order.push("committed");
      return [{ id: "event-1" }];
    });
    const database = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoUpdate: vi.fn(() => ({ returning })),
        })),
      })),
    };
    const recorder = new EventRecorder({
      database: database as never,
      generateId: () => "generated-id",
      sanitizePayload: (payload) => payload,
      publish: vi.fn(async () => {
        order.push("published");
      }),
      onPublishError: vi.fn(),
    });

    await recorder.record("user-1", activityInput());
    await vi.waitFor(() => expect(order).toEqual(["committed", "published"]));
  });

  test("gives repeated runtime events stable occurrence identities", async () => {
    const inserted: Record<string, unknown>[] = [];
    let nextId = 0;
    const database = {
      insert: vi.fn(() => ({
        values: vi.fn((value) => {
          inserted.push(value);
          return {
            onConflictDoUpdate: vi.fn(() => ({
              returning: vi.fn(async () => [value]),
            })),
          };
        }),
      })),
    };
    const recorder = new EventRecorder({
      database: database as never,
      generateId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
      sanitizePayload: (payload) => payload,
      publish: vi.fn(async () => undefined),
      onPublishError: vi.fn(),
    });
    for (const eventType of ["model.completed", "tool.completed"] as const) {
      const runtimeEvent = {
        actorType: "system" as const,
        eventType,
        subjectType: "agent_run",
        runId: "run-1",
        payload: { stepNumber: 1 },
      };
      await recorder.recordRuntime("user-1", runtimeEvent);
      await recorder.recordRuntime("user-1", runtimeEvent);
    }

    expect(inserted).toHaveLength(4);
    expect(new Set(inserted.map(({ occurrenceId }) => occurrenceId)).size).toBe(
      4,
    );
    expect(
      new Set(inserted.map(({ idempotencyKey }) => idempotencyKey)).size,
    ).toBe(4);
  });
});
