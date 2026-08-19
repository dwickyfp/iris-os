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

  test("accepts runtime trajectory events", () => {
    expect(
      ActivityEventInputSchema.parse({
        actorType: "agent",
        eventType: "trajectory.step_completed",
        subjectType: "trajectory",
        payload: { attempt: 1, toStatus: "running" },
        runId: "run-1",
        idempotencyKey: "trajectory.step_completed:run-1:1",
      }).eventType,
    ).toBe("trajectory.step_completed");
  });

  test("accepts sanitized remote-agent lifecycle events", () => {
    expect(
      ActivityEventInputSchema.parse({
        actorType: "agent",
        eventType: "agent.remote_task_created",
        subjectType: "agent_run",
        payload: { targetType: "remote_agent", toStatus: "submitted" },
        runId: "run-1",
        idempotencyKey: "agent.remote_task_created:run-1",
      }).payload,
    ).toMatchObject({ targetType: "remote_agent" });
  });

  test("validates artifact verification events", () => {
    const artifactId = "0f98f5c9-45f1-4a5f-88e4-56724ab11701";
    expect(
      ActivityEventInputSchema.parse({
        actorType: "system",
        eventType: "artifact.verification_completed",
        subjectType: "artifact",
        subjectId: artifactId,
        payload: {
          artifactId,
          verified: true,
          sha256: "a".repeat(64),
        },
        idempotencyKey: `artifact.verification_completed:${artifactId}`,
      }).eventType,
    ).toBe("artifact.verification_completed");
  });

  test("accepts context and completion verification events", () => {
    expect(
      ActivityEventInputSchema.parse({
        actorType: "system",
        eventType: "context.prepared",
        subjectType: "agent_run",
        payload: {
          compacted: true,
          estimatedTokensBefore: 200,
          estimatedTokensAfter: 100,
          sourceCount: 2,
        },
        idempotencyKey: "context.prepared:run-1",
      }).eventType,
    ).toBe("context.prepared");
    expect(
      ActivityEventInputSchema.parse({
        actorType: "system",
        eventType: "verification.failed",
        subjectType: "agent_run",
        payload: {
          verified: false,
          reason: "HASH_MISMATCH",
          requirementCount: 1,
        },
        idempotencyKey: "verification.failed:run-1",
      }).eventType,
    ).toBe("verification.failed");
  });
});
