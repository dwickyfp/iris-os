import { describe, expect, test, vi } from "vitest";
import { RunPreparer } from "./run-preparer";

describe("RunPreparer", () => {
  test("uses the same resolved instructions and messages for any caller", async () => {
    const resolve = vi.fn(async (input: any) => ({
      trustedInstructions: input.instructions ?? "resolved",
      dataPlaneObservations: "",
      instructions: input.instructions ?? "resolved",
      messages: input.messages ?? [],
      sourceRecords: [],
      estimatedTokens: 0,
      truncatedSources: [],
      trustBoundaries: [],
      provenance: [],
      diagnostics: {
        compacted: false,
        estimatedTokensBefore: 0,
        estimatedTokensAfter: 0,
        budget: 0,
        retainedMessages: 0,
        summarizedMessages: 0,
      },
    }));
    const preparer = new RunPreparer({ resolve });
    const input = { request: "run", instructions: "policy", messages: [] };
    const chat = await preparer.prepare(input);
    const automation = await preparer.prepare(input);
    expect(chat).toEqual(automation);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  test("resolves the v2 execution contract through dependency interfaces", async () => {
    const context = {
      trustedInstructions: "trusted",
      dataPlaneObservations: "",
      instructions: "trusted",
      messages: [],
      sourceRecords: [],
      estimatedTokens: 12,
      truncatedSources: [],
      trustBoundaries: ["remote_observation:untrusted"],
      provenance: [],
      diagnostics: {
        compacted: false,
        estimatedTokensBefore: 12,
        estimatedTokensAfter: 12,
        budget: 100,
        retainedMessages: 0,
        summarizedMessages: 0,
      },
    };
    const capabilities = { tools: ["search"] };
    const policy = { approvalPolicy: "never" as const, tools: {} };
    const runtimeContext = { runId: "run-1" } as any;
    const completionRequirement = {
      kind: "outcome" as const,
      verifyCompletion: vi.fn(),
    };
    const preparer = new RunPreparer(
      { resolve: vi.fn(async () => context) },
      {
        resolveCapabilities: vi.fn(async () => ({
          value: capabilities,
          snapshot: { selectedIds: ["builtin:search"] },
        })),
        resolvePolicy: vi.fn(async ({ capabilities: resolved }) => {
          expect(resolved).toBe(capabilities);
          return policy;
        }),
        resolveBudget: vi.fn(async () => ({ maxTokens: 2_000 })),
        resolveRuntimeContext: vi.fn(async ({ policy: resolved }) => {
          expect(resolved).toBe(policy);
          return runtimeContext;
        }),
        resolveCompletion: vi.fn(async () => ({
          requirement: completionRequirement,
          snapshot: { goal: "answer" },
        })),
        resolveModel: vi.fn(async () => ({
          value: "model",
          descriptor: { provider: "fake", model: "one" },
        })),
        resolveDriver: vi.fn(async () => ({
          descriptor: { id: "ai-sdk" },
        })),
      },
    );

    const prepared = await preparer.prepare({ goal: "answer" });

    expect(prepared).toMatchObject({
      capabilities,
      policy,
      budget: { maxTokens: 2_000 },
      runtimeContext,
      completionRequirement,
      model: "model",
      snapshot: {
        routing: { selectedIds: ["builtin:search"] },
        budget: { maxTokens: 2_000 },
        completion: { goal: "answer" },
        model: { provider: "fake", model: "one" },
        driver: { id: "ai-sdk" },
      },
    });
  });

  test("restores snapshots but authoritatively re-resolves their budget", async () => {
    const resolveBudget = vi.fn(async (input) => ({
      maxTokens: Math.min(99, input.restore?.budget?.maxTokens ?? 99),
    }));
    const preparer = new RunPreparer(
      {
        resolve: vi.fn(async () => ({
          trustedInstructions: "trusted",
          dataPlaneObservations: "joined",
          instructions: "trusted",
          messages: [],
          sourceRecords: [],
          estimatedTokens: 1,
          truncatedSources: [],
          trustBoundaries: ["remote_observation:untrusted"],
          provenance: [],
          diagnostics: {} as any,
        })),
      },
      {
        resolveCapabilities: vi.fn(async () => ({
          value: {},
          snapshot: { selectedIds: ["new"] },
        })),
        resolveBudget,
        resolveCompletion: vi.fn(async () => ({ snapshot: { goal: "new" } })),
      },
    );

    const prepared = await preparer.prepare({
      restore: {
        routing: { selectedIds: ["persisted"] },
        budget: { maxTokens: 7 },
        completion: { goal: "persisted" },
        context: {
          sourceRecords: [],
          estimatedTokens: 1,
          truncatedSources: [],
          trustBoundaries: ["memory:mixed"],
          provenance: [],
          diagnostics: {} as any,
        },
      },
    });

    expect(resolveBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        restore: expect.objectContaining({ budget: { maxTokens: 7 } }),
      }),
    );
    expect(prepared.snapshot).toMatchObject({
      routing: { selectedIds: ["persisted"] },
      budget: { maxTokens: 7 },
      completion: { goal: "persisted" },
    });
    expect(prepared.context.trustBoundaries).toContain(
      "remote_observation:untrusted",
    );
    expect(prepared.snapshot.context?.trustBoundaries).toEqual([
      "memory:mixed",
      "remote_observation:untrusted",
    ]);
  });

  test("keeps chat, automation, and resume on the same normalized requirement", async () => {
    const resolve = vi.fn(async () => ({
      trustedInstructions: "trusted",
      dataPlaneObservations: "",
      instructions: "trusted",
      messages: [],
      sourceRecords: [],
      estimatedTokens: 0,
      truncatedSources: [],
      trustBoundaries: [],
      provenance: [],
      diagnostics: {} as any,
    }));
    const preparer = new RunPreparer({ resolve });
    const input = {
      goal: "create Q2 revenue PDF report",
      selectedCapabilities: ["generate_report"],
    };
    const chat = await preparer.prepare(input);
    const automation = await preparer.prepare(input);
    const resume = await preparer.prepare({
      restore: { completion: chat.goalRequirement },
    });

    expect(automation.goalRequirement).toEqual(chat.goalRequirement);
    expect(resume.goalRequirement).toEqual(chat.goalRequirement);
    expect(chat.snapshot.completion).toEqual(chat.goalRequirement);
  });

  test("upgrades a persisted execution-level goal to outcome semantics", async () => {
    const preparer = new RunPreparer({
      resolve: vi.fn(async () => ({
        trustedInstructions: "trusted",
        dataPlaneObservations: "",
        instructions: "trusted",
        messages: [],
        sourceRecords: [],
        estimatedTokens: 0,
        truncatedSources: [],
        trustBoundaries: [],
        provenance: [],
        diagnostics: {} as any,
      })),
    });

    const prepared = await preparer.prepare({
      restore: {
        completion: {
          goal: "legacy",
          level: "execution",
          requiredArtifactKinds: [],
          requiredMediaTypes: [],
          requiredSections: [],
          requiredCapabilities: [],
          analysisOnlyAllowed: false,
        },
      },
    });

    expect(prepared.goalRequirement.level).toBe("outcome");
  });

  test("gives chat and automation equivalent capabilities for the same scope and goal", async () => {
    const resolve = vi.fn(async () => ({
      trustedInstructions: "trusted",
      dataPlaneObservations: "",
      instructions: "trusted",
      messages: [],
      sourceRecords: [],
      estimatedTokens: 1,
      truncatedSources: [],
      trustBoundaries: [],
      provenance: [],
      diagnostics: {} as any,
    }));
    const preparer = new RunPreparer(
      { resolve },
      {
        resolveCapabilities: async (input) => ({
          value: [`${input.agentId}:${input.workspaceId}:${input.goal}`],
          snapshot: { selectedIds: ["builtin:search"] },
        }),
        resolvePolicy: async ({ request }) => ({
          approvalPolicy: "never",
          tools: {},
          authority: request.authority,
        }),
      },
    );
    const scope = {
      userId: "user-1",
      agentId: "agent-1",
      workspaceId: "workspace-1",
      goal: "research parity",
    };

    const chat = await preparer.prepare({ ...scope, surface: "chat" });
    const automation = await preparer.prepare({
      ...scope,
      surface: "automation",
    });

    expect(chat.capabilities).toEqual(automation.capabilities);
    expect(chat.snapshot.routing).toEqual(automation.snapshot.routing);
    expect(chat.policy).toEqual(automation.policy);

    const bounded = await preparer.prepare({
      ...scope,
      surface: "automation",
      authority: { capabilityIds: ["builtin:search"] },
    });
    expect(bounded.capabilities).toEqual(chat.capabilities);
    expect(bounded.policy?.authority).not.toEqual(chat.policy?.authority);
  });
});
