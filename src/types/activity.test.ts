import { describe, expect, test } from "vitest";
import { ActivityEventInputSchema } from "./activity";

describe("ActivityEventInputSchema", () => {
  test("rejects unknown event types", () => {
    expect(() =>
      ActivityEventInputSchema.parse({
        actorType: "system",
        eventType: "anything.happened",
        subjectType: "test",
        payload: {},
        idempotencyKey: "test:1",
      }),
    ).toThrow();
  });

  test("validates exact scope", () => {
    expect(() =>
      ActivityEventInputSchema.parse({
        actorType: "system",
        scopeType: "workspace",
        eventType: "task.created",
        subjectType: "task",
        payload: {},
        idempotencyKey: "test:2",
      }),
    ).toThrow(/scopeId/i);
  });
});
