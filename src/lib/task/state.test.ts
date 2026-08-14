import { describe, expect, it } from "vitest";
import { assertTaskTransition, canTransitionTask } from "./state";

describe("task state transitions", () => {
  it("supports the normal work lifecycle", () => {
    expect(canTransitionTask("planned", "in_progress")).toBe(true);
    expect(canTransitionTask("in_progress", "blocked")).toBe(true);
    expect(canTransitionTask("blocked", "in_progress")).toBe(true);
    expect(canTransitionTask("in_progress", "completed")).toBe(true);
  });

  it("rejects reopening terminal tasks implicitly", () => {
    expect(() => assertTaskTransition("completed", "in_progress")).toThrow(
      "Invalid task transition",
    );
    expect(canTransitionTask("cancelled", "planned")).toBe(false);
  });
});
