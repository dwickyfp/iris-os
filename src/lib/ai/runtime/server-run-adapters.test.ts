import { describe, expect, test, vi } from "vitest";
import type { RunPreparationInput } from "./run-preparer";

vi.mock("server-only", () => ({}));
vi.mock("lib/ai/context-compaction", () => ({
  contextEngine: {
    resolve: vi.fn(async (input: RunPreparationInput) => ({
      trustedInstructions: input.instructions ?? "",
      dataPlaneObservations: "",
      instructions: input.instructions ?? "",
      messages: input.messages ?? [],
      sourceRecords: [],
      estimatedTokens: 0,
      truncatedSources: [],
      trustBoundaries: [],
      provenance: [],
      diagnostics: {} as any,
    })),
  },
}));

import {
  type ProductionPreparationProfile,
  createProductionRunAdapter,
} from "./server-run-adapters";

const descriptors = [
  {
    id: "builtin:search",
    key: "search",
    kind: "builtin",
    risks: ["read"] as const,
  },
  {
    id: "builtin:write",
    key: "write",
    kind: "builtin",
    risks: ["write"] as const,
  },
];
const authority = {
  capabilityIds: descriptors.map(({ id }) => id),
  maximumRisks: ["read", "write"] as const,
};

function adapter(profile: ProductionPreparationProfile) {
  return createProductionRunAdapter(profile, {
    resolveCapabilities: async () => ({
      value: { id: "canonical" },
      tools: { search: {}, write: {} },
      descriptors,
      selectedCapabilities: descriptors,
      routing: { diagnostics: { mode: "test" } },
    }),
    resolveRuntimeContext: async ({ policy }) =>
      ({
        requestId: "request-1",
        runId: "run-1",
        userId: "user-1",
        agentType: "base",
        toolMode: "auto",
        approvalPolicy: policy.approvalPolicy,
        skills: [],
      }) as any,
    resolveModel: async () => ({
      value: "model",
      descriptor: { provider: "test", model: "canonical" },
    }),
    resolveBudget: async (input) => ({
      maxTokens: Math.min(1_000, input.requestedBudget?.maxTokens ?? 1_000),
    }),
  });
}

async function prepare(profile: ProductionPreparationProfile) {
  const production = adapter(profile);
  const capabilities = await production.resolveCapabilities(undefined);
  return production.prepare({
    capabilities,
    request: {
      userId: "user-1",
      goal: "research",
      instructions: "trusted",
      requestedBudget: { maxTokens: 800 },
    },
  });
}

describe("production run adapters", () => {
  test("same authority preserves canonical base semantics across surfaces", async () => {
    const chat = await prepare({
      surface: "chat",
      approvalPolicy: "never",
      authority: { ...authority, maximumRisks: [...authority.maximumRisks] },
    });
    const automation = await prepare({
      surface: "automation",
      approvalPolicy: "never",
      authority: { ...authority, maximumRisks: [...authority.maximumRisks] },
    });

    expect(automation.capabilities).toEqual(chat.capabilities);
    expect(automation.policy).toEqual(chat.policy);
    expect(automation.budget).toEqual(chat.budget);
    expect(automation.runtimeContext?.approvalPolicy).toBe(
      chat.runtimeContext?.approvalPolicy,
    );
    expect(automation.snapshot.model).toEqual(chat.snapshot.model);
    expect(automation.snapshot.driver).toEqual({ id: "ai-sdk" });
    expect(automation.snapshot.completion).toEqual(chat.snapshot.completion);
  });

  test("records automation subtraction as an explicit profile difference", async () => {
    const production = adapter({
      surface: "automation",
      approvalPolicy: "never",
      authority: { ...authority, maximumRisks: [...authority.maximumRisks] },
      allowedToolKeys: ["search"],
    });
    const capabilities = await production.resolveCapabilities(undefined);

    expect(capabilities.descriptors.map(({ key }) => key)).toEqual(["search"]);
    expect(capabilities.routing).toMatchObject({
      descriptorIds: ["builtin:search"],
      subtractions: [
        {
          id: "builtin:write",
          key: "write",
          reason: "tool_allowlist",
        },
      ],
    });
  });

  test("resume intersects persisted authority and cannot widen it", async () => {
    const resumed = await prepare({
      surface: "resume",
      approvalPolicy: "never",
      authority: { capabilityIds: ["builtin:search", "builtin:write"] },
      persistedPolicy: {
        approvalPolicy: "destructive_only",
        tools: {},
        authority: { capabilityIds: ["builtin:search"] },
      },
    });

    expect(resumed.policy?.approvalPolicy).toBe("destructive_only");
    expect(resumed.policy?.authority?.capabilityIds).toEqual([
      "builtin:search",
    ]);
    expect(Object.keys(resumed.policy?.tools ?? {})).toEqual(["search"]);
  });

  test("delegation receives the injected child allocation", async () => {
    const production = adapter({
      surface: "delegation",
      approvalPolicy: "never",
      allowedToolKeys: ["search", "write"],
      authority: { ...authority, maximumRisks: [...authority.maximumRisks] },
      childAllocation: {
        authority: { capabilityIds: ["builtin:search"] },
        budget: { maxTokens: 250 },
      },
    });
    const capabilities = await production.resolveCapabilities(undefined);
    const delegated = await production.prepare({
      capabilities,
      request: { userId: "user-1", goal: "research" },
    });

    expect(delegated.policy?.authority?.capabilityIds).toEqual([
      "builtin:search",
    ]);
    expect(delegated.budget).toEqual({ maxTokens: 250 });
  });

  test("delegation applies the same allowlist narrowing and then child authority", async () => {
    const production = adapter({
      surface: "delegation",
      approvalPolicy: "never",
      allowedToolKeys: ["search"],
      authority: { capabilityIds: ["builtin:search", "builtin:write"] },
      childAllocation: { authority: { capabilityIds: ["builtin:write"] } },
    });

    const capabilities = await production.resolveCapabilities(undefined);
    const delegated = await production.prepare({
      capabilities,
      request: { userId: "user-1", goal: "research" },
    });

    expect(capabilities.tools).toEqual({});
    expect(delegated.policy?.authority?.capabilityIds).toEqual([]);
    expect(delegated.policy?.tools).toEqual({});
  });

  test("persisted empty delegation allowlist exposes no tools", async () => {
    const production = adapter({
      surface: "delegation",
      approvalPolicy: "never",
      allowedToolKeys: [],
      childAllocation: { authority: {} },
    });

    const capabilities = await production.resolveCapabilities(undefined);

    expect(capabilities.tools).toEqual({});
    expect(capabilities.descriptors).toEqual([]);
  });
});
