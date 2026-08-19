import { describe, expect, it, vi } from "vitest";
import { createDelegateWorkTool } from "./delegate-work";

vi.mock("server-only", () => ({}));

describe("delegate_agent tool", () => {
  it("describes and constrains the exact eligible target set", () => {
    const delegate = createDelegateWorkTool({
      parentRunId: "run-1",
      userId: "user-1",
      targets: [
        {
          kind: "local",
          agentId: "agent-1",
          name: "Reviewer",
        },
        {
          kind: "remote",
          connectionId: "remote-1",
          name: "Research service",
        },
      ],
    });

    expect(delegate.description).toContain("local:agent-1 (Reviewer)");
    expect(delegate.description).toContain(
      "remote:remote-1 (Research service)",
    );
    expect(delegate.inputSchema).toMatchObject({
      jsonSchema: {
        properties: {
          target: {
            enum: ["local:agent-1", "remote:remote-1"],
          },
        },
        required: ["target", "objective"],
      },
    });
  });
});
