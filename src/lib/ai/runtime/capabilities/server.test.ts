import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildServerCapabilityResolutionInput,
  resolveServerCapabilities,
  subtractAutomationCapabilities,
} from "./server";

const repositories = vi.hoisted(() => ({
  agents: vi.fn(),
  remoteAgents: vi.fn(),
  workflows: vi.fn(),
  assignedSkills: vi.fn(),
  skillById: vi.fn(),
  skillContent: vi.fn(),
  skillFile: vi.fn(),
  mcpServers: vi.fn(),
}));
const selectScopedSkills = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("lib/db/repository", () => ({
  agentRepository: { selectAgentsByUserId: repositories.agents },
  remoteAgentRepository: { listByUserId: repositories.remoteAgents },
  workflowRepository: { selectExecuteAbility: repositories.workflows },
  mcpRepository: { selectAllForUser: repositories.mcpServers },
  skillRepository: {
    selectSkillSummariesByAgentId: repositories.assignedSkills,
    selectSkillById: repositories.skillById,
    selectSkillContentById: repositories.skillContent,
    selectSkillFileByPath: repositories.skillFile,
  },
}));
vi.mock("lib/ai/skill/scoped-learned", () => ({
  selectScopedLearnedSkillSummaries: selectScopedSkills,
}));
vi.mock("lib/ai/mcp/mcp-manager", () => ({
  mcpClientsManager: {
    tools: () => ({
      warehouse_query: {
        description: "Query the revenue warehouse",
        _mcpServerId: "warehouse",
        _mcpServerName: "Warehouse",
        _originToolName: "query",
      },
    }),
  },
}));
vi.mock("../../../../app/api/chat/shared.chat", () => ({
  workflowToVercelAITool: (workflow: { name: string }) => ({
    description: `Run ${workflow.name}`,
  }),
}));
vi.mock("lib/ai/tools/delegation/delegate-work", () => ({
  createDelegateWorkTool: () => ({ description: "Delegate work" }),
}));
vi.mock("lib/ai/tools/tool-kit", () => ({
  APP_DEFAULT_TOOL_KIT: {
    reports: {
      generate_report: { description: "Generate a report" },
    },
  },
}));

describe("production server capability parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CAPABILITY_ROUTER_THRESHOLD = "100";
    repositories.agents.mockResolvedValue([
      { id: "peer-1", name: "Local analyst", description: "Local peer" },
    ]);
    repositories.remoteAgents.mockResolvedValue([
      {
        id: "remote-1",
        name: "Remote analyst",
        description: "Remote A2A peer",
        status: "active",
        agentCard: { name: "Remote analyst", skills: ["research"] },
        discoveredAt: new Date(),
        credentialType: null,
        encryptedCredential: null,
      },
    ]);
    repositories.workflows.mockResolvedValue([
      {
        id: "workflow-1",
        name: "revenue_workflow",
        description: "Revenue workflow",
        schema: {},
      },
    ]);
    repositories.assignedSkills.mockResolvedValue([]);
    repositories.mcpServers.mockResolvedValue([{ id: "warehouse" }]);
    selectScopedSkills.mockResolvedValue([
      { id: "skill-1", name: "Revenue skill", description: "Analyze revenue" },
    ]);
  });

  test("Chat and headless surfaces start from identical eligible IDs and diagnostics", async () => {
    const common = {
      userId: "user-1",
      workspaceId: "workspace-1",
      taskId: "task-1",
      runId: "run-1",
      goal: "research revenue and generate a report",
      hints: {
        mode: "prefer" as const,
        requested: [
          {
            type: "remoteAgent" as const,
            agentId: "remote-1",
            name: "Remote analyst",
          },
        ],
      },
      permissions: {
        allowedMcpServers: { warehouse: { tools: ["query"] } },
      },
      featureState: {
        tools: true,
        workflows: true,
        delegation: true,
        remoteAgents: true,
        learning: true,
      },
    };

    const chat = await resolveServerCapabilities(
      await buildServerCapabilityResolutionInput(common),
    );
    const automation = await resolveServerCapabilities(
      await buildServerCapabilityResolutionInput(common),
    );
    const ids = chat.ordered.map(({ id }) => id);
    const { elapsedMs: _chatElapsedMs, ...chatRouting } = chat.routing ?? {};
    const { elapsedMs: _automationElapsedMs, ...automationRouting } =
      automation.routing ?? {};

    expect(automation.ordered.map(({ id }) => id)).toEqual(ids);
    expect(automationRouting).toEqual(chatRouting);
    expect(ids).toEqual(
      expect.arrayContaining([
        "remote-peer:remote-1",
        "builtin:generate_report",
        "mcp:warehouse:query",
        "workflow:workflow-1",
        "skill-runtime:skills_list",
      ]),
    );
    expect(selectScopedSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        workspaceId: "workspace-1",
        taskId: "task-1",
      }),
    );
  });

  test("client MCP allowlists cannot bind servers outside user ownership", async () => {
    repositories.mcpServers.mockResolvedValue([{ id: "owned-server" }]);
    const resolved = await resolveServerCapabilities(
      await buildServerCapabilityResolutionInput({
        userId: "user-1",
        runId: "run-1",
        goal: "query the warehouse",
        permissions: {
          allowedMcpServers: { warehouse: { tools: ["query"] } },
        },
        featureState: {
          tools: true,
          workflows: false,
          delegation: false,
          remoteAgents: false,
          learning: false,
        },
      }),
    );

    expect(resolved.ordered.map(({ id }) => id)).not.toContain(
      "mcp:warehouse:query",
    );
    expect(resolved.executable.warehouse_query).toBeUndefined();
  });

  test("automation allowlists only subtract and record an explicit reason", async () => {
    const resolved = await resolveServerCapabilities(
      await buildServerCapabilityResolutionInput({
        userId: "user-1",
        runId: "run-1",
        goal: "generate a report",
        featureState: {
          tools: true,
          workflows: true,
          delegation: true,
          remoteAgents: true,
          learning: true,
        },
      }),
    );
    const bounded = subtractAutomationCapabilities(resolved.ordered, [
      "generate_report",
    ]);

    expect(bounded.descriptors.map(({ id }) => id)).toEqual([
      "builtin:generate_report",
    ]);
    expect(
      bounded.descriptors.every((descriptor) =>
        resolved.ordered.includes(descriptor),
      ),
    ).toBe(true);
    expect(bounded.subtractions).toContainEqual({
      id: "skill-runtime:skills_list",
      key: "skills_list",
      reason: "automation_tool_allowlist",
    });
  });

  test("explicit Chat hints cannot expand custom-agent authority", async () => {
    const resolved = await resolveServerCapabilities(
      await buildServerCapabilityResolutionInput({
        userId: "user-1",
        runId: "run-1",
        goal: "run the mentioned workflow",
        agent: {
          id: "agent-1",
          userId: "user-1",
          name: "Bounded agent",
          instructions: {
            role: "analyst",
            systemPrompt: "Analyze",
            capabilities: [{ type: "defaultTool", name: "generate_report" }],
          },
        } as any,
        hints: {
          mode: "prefer",
          requested: [
            {
              type: "workflow",
              workflowId: "workflow-1",
              name: "revenue_workflow",
            },
          ],
        },
        featureState: {
          tools: true,
          workflows: true,
          delegation: true,
          remoteAgents: true,
          learning: true,
        },
      }),
    );

    expect(resolved.ordered.map(({ id }) => id)).toContain(
      "builtin:generate_report",
    );
    expect(resolved.ordered.map(({ id }) => id)).not.toContain(
      "workflow:workflow-1",
    );
  });

  test("a configured healthy remote peer enters a custom agent universe while a stale binding is omitted", async () => {
    const resolved = await resolveServerCapabilities(
      await buildServerCapabilityResolutionInput({
        userId: "user-1",
        runId: "run-1",
        goal: "research with the configured peer",
        agent: {
          id: "agent-1",
          userId: "user-1",
          name: "Remote research agent",
          instructions: {
            capabilities: [
              {
                type: "remoteAgent",
                agentId: "remote-1",
                name: "Remote analyst",
              },
              {
                type: "remoteAgent",
                agentId: "deleted-remote",
                name: "Deleted remote",
              },
            ],
          },
        } as any,
        featureState: {
          tools: true,
          workflows: true,
          delegation: true,
          remoteAgents: true,
          learning: true,
        },
      }),
    );

    expect(resolved.ordered.map(({ id }) => id)).toEqual([
      "remote-peer:remote-1",
    ]);
    expect(resolved.eligibleDelegationTargets).toEqual(["remote:remote-1"]);
  });
});
