import { describe, expect, it } from "vitest";
import { buildBaseAgentSystemPrompt } from "./prompts";

describe("buildBaseAgentSystemPrompt", () => {
  it("instructs the base agent to use and verify tools safely", () => {
    const prompt = buildBaseAgentSystemPrompt();

    expect(prompt).toMatch(/Use tools only when they add\s+real value/);
    expect(prompt).toMatch(/verify important tool results/);
    expect(prompt).toContain("Keep internal reasoning private");
  });
});
