import { describe, expect, it } from "vitest";
import { ContextPlanner } from "./context-planner";

describe("ContextPlanner", () => {
  it("orders context by runtime precedence and marks trust", () => {
    const result = new ContextPlanner(10_000).plan({
      currentRequest: "request",
      task: "task",
      workspaceInstructions: "workspace",
      agentAndSkills: "agent",
      memories: "memory",
      resources: "resources",
      conversation: "conversation",
    });
    expect(result.sections.map((section) => section.source)).toEqual([
      "current_request",
      "task",
      "workspace_instructions",
      "agent_and_skills",
      "memory",
      "resources",
      "conversation",
    ]);
    expect(result.sections.find((section) => section.trusted)?.source).toBe(
      "workspace_instructions",
    );
  });

  it("drops lowest priority sections first when over budget", () => {
    const result = new ContextPlanner(4).plan({
      currentRequest: "12345678",
      task: "12345678",
      conversation: "12345678",
    });
    expect(result.sections.map((section) => section.source)).toEqual([
      "current_request",
      "task",
    ]);
    expect(result.truncated).toContain("conversation");
  });
});
