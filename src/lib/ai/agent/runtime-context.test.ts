import { describe, expect, it } from "vitest";
import {
  createAgentRuntimeContext,
  createBaseAgentRuntimeContext,
} from "./runtime-context";

describe("createAgentRuntimeContext", () => {
  it("keeps request metadata outside the model prompt", () => {
    const context = createAgentRuntimeContext({
      requestId: "request-1",
      userId: "user-1",
      threadId: "thread-1",
      agent: { id: "agent-1" } as any,
      userRole: "user",
      toolChoice: "auto",
      skills: [],
    });

    expect(context).toEqual({
      requestId: "request-1",
      userId: "user-1",
      threadId: "thread-1",
      agentType: "custom",
      agentId: "agent-1",
      userRole: "user",
      toolChoice: "auto",
      skills: [],
    });
  });

  it("creates an implicit base-agent context without an agent id or skills", () => {
    expect(
      createBaseAgentRuntimeContext({
        requestId: "request-1",
        userId: "user-1",
        threadId: "thread-1",
        userRole: "user",
        toolChoice: "auto",
      }),
    ).toEqual({
      requestId: "request-1",
      userId: "user-1",
      threadId: "thread-1",
      agentType: "base",
      userRole: "user",
      toolChoice: "auto",
      skills: [],
    });
  });
});
