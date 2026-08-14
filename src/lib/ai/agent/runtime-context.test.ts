import { describe, expect, it } from "vitest";
import {
  createAgentRuntimeContext,
  createBaseAgentRuntimeContext,
} from "./runtime-context";

describe("createAgentRuntimeContext", () => {
  it("preserves execution scope and approval metadata outside the prompt", () => {
    const context = createAgentRuntimeContext({
      requestId: "request-1",
      runId: "run-1",
      userId: "user-1",
      threadId: "thread-1",
      workspaceId: "workspace-1",
      taskId: "task-1",
      agent: { id: "agent-1" } as any,
      userRole: "user",
      toolMode: "auto",
      approvalPolicy: "destructive_only",
      skills: [],
    });

    expect(context).toEqual({
      requestId: "request-1",
      runId: "run-1",
      userId: "user-1",
      threadId: "thread-1",
      workspaceId: "workspace-1",
      taskId: "task-1",
      agentType: "custom",
      agentId: "agent-1",
      userRole: "user",
      toolMode: "auto",
      approvalPolicy: "destructive_only",
      skills: [],
    });
  });

  it("creates an implicit base-agent context without an agent id or skills", () => {
    expect(
      createBaseAgentRuntimeContext({
        requestId: "request-1",
        runId: "run-1",
        userId: "user-1",
        threadId: "thread-1",
        userRole: "user",
        toolMode: "none",
        approvalPolicy: "always",
      }),
    ).toEqual({
      requestId: "request-1",
      runId: "run-1",
      userId: "user-1",
      threadId: "thread-1",
      agentType: "base",
      userRole: "user",
      toolMode: "none",
      approvalPolicy: "always",
      skills: [],
    });
  });
});
