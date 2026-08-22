import { NodeKind } from "lib/ai/workflow/workflow.interface";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  resolveAutomationAuthority,
  workflowAuthoritySnapshot,
} from "./authority";

vi.mock("server-only", () => ({}));
vi.mock("lib/db/repository", () => ({
  workflowRepository: {
    checkAccess: vi.fn(),
    selectStructureById: vi.fn(),
  },
  skillRepository: { selectSkillById: vi.fn() },
  agentRepository: { selectAgentById: vi.fn() },
}));

describe("automation authorization authority", () => {
  beforeEach(() => vi.clearAllMocks());

  test("captures exact workflow target capabilities at authorization time", () => {
    expect(
      workflowAuthoritySnapshot([
        {
          kind: NodeKind.Tool,
          nodeConfig: {
            tool: { type: "mcp-tool", serverId: "db", id: "query" },
          },
        },
        { kind: NodeKind.Compute, nodeConfig: {} },
      ]),
    ).toEqual({
      version: 1,
      allowedTools: ["query"],
      capabilityIds: ["mcp:db:query", "sandbox:execute_python"],
    });
  });

  test("captures an empty skill grant without persisted secrets", async () => {
    const repositories = await import("lib/db/repository");
    vi.mocked(repositories.skillRepository.selectSkillById).mockResolvedValue({
      id: "skill-1",
      userId: "user-1",
      allowedTools: [],
    } as never);
    const snapshot = await resolveAutomationAuthority({
      targetType: "skill",
      targetId: "skill-1",
      userId: "user-1",
    });
    expect(snapshot).toEqual({
      version: 1,
      allowedTools: [],
      capabilityIds: [],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|token|credential/i);
  });
});
