import { describe, expect, it } from "vitest";
import type { CapabilityDescriptor } from "./registry";
import {
  capabilitySearchDocument,
  routeCapabilityDocuments,
} from "./semantic-router";

function descriptor(
  id: string,
  input: Partial<CapabilityDescriptor> = {},
): CapabilityDescriptor {
  return {
    id,
    key: id,
    kind: "builtin",
    name: id,
    surfaces: ["executable"],
    value: id,
    ...input,
  };
}

describe("semantic capability router", () => {
  it("selects Snowflake-like revenue access and report generation from 100+ capabilities", () => {
    const capabilities = Array.from({ length: 120 }, (_, index) =>
      descriptor(`noise-${index}`, {
        description: `Calendar utility number ${index}`,
      }),
    );
    capabilities.splice(
      41,
      0,
      descriptor("mcp:snowflake:query", {
        kind: "mcp",
        name: "Snowflake warehouse query",
        description: "Analyze revenue and finance data in the warehouse",
        search: { provider: ["Snowflake"] },
      }),
      descriptor("builtin:generate_report", {
        name: "generate_report",
        description: "Generate a business report from analysis",
      }),
    );

    const result = routeCapabilityDocuments(
      capabilities.map((item) => capabilitySearchDocument(item)),
      "Analyze revenue and generate a report",
      new Set(),
      { config: { topN: 8 } },
    );

    expect(result.selectedIds).toContain("mcp:snowflake:query");
    expect(result.selectedIds).toContain("builtin:generate_report");
    expect(result.selectedIds.length).toBeLessThanOrEqual(8);
    expect(result.selectedIds).not.toContain("noise-0");
    expect(result.diagnostics).toMatchObject({
      event: "capability.routing",
      strategy: "stage1-lexical",
      candidateCount: 122,
    });
  });

  it("normalizes workflow, local agent, and remote Agent Card semantics", () => {
    const kinds: CapabilityDescriptor["kind"][] = [
      "builtin",
      "mcp",
      "workflow",
      "localPeer",
      "remotePeer",
    ];
    const documents = kinds.map((kind) =>
      capabilitySearchDocument(
        descriptor(kind, {
          kind,
          name: `${kind} revenue analyst`,
          search: {
            aliases: ["finance"],
            provider: ["Snowflake Inc"],
            skills: ["forecast revenue"],
          },
        }),
        `${kind}-provider`,
      ),
    );

    expect(documents.map(({ kind }) => kind)).toEqual(kinds);
    expect(documents.at(-1)).toMatchObject({
      aliases: ["finance"],
      provider: ["remotePeer-provider", "Snowflake Inc"],
      skills: ["forecast revenue"],
    });
    expect(documents.at(-1)?.tokens).toEqual(
      expect.arrayContaining(["snowflake", "forecast", "revenue"]),
    );
  });

  it("pins an explicit hint even when it is lexically irrelevant", () => {
    const documents = [
      descriptor("builtin:hinted", { description: "Edit an image" }),
      descriptor("builtin:revenue", { description: "Analyze revenue" }),
    ].map((item) => capabilitySearchDocument(item));

    const result = routeCapabilityDocuments(
      documents,
      "revenue analysis",
      new Set(["builtin:hinted"]),
      { config: { topN: 1 } },
    );

    expect(result.selectedIds).toEqual(["builtin:hinted"]);
    expect(result.diagnostics.pinnedIds).toEqual(["builtin:hinted"]);
  });

  it("falls back to a deterministic bounded set while preserving hints", () => {
    const documents = Array.from({ length: 30 }, (_, index) =>
      capabilitySearchDocument(descriptor(`builtin:${index}`)),
    );
    let clock = 0;

    const result = routeCapabilityDocuments(
      documents,
      "revenue",
      new Set(["builtin:29"]),
      {
        config: { topN: 5, timeoutMs: 1 },
        now: () => clock++,
      },
    );

    expect(result.selectedIds).toEqual([
      "builtin:29",
      "builtin:0",
      "builtin:1",
      "builtin:2",
      "builtin:3",
    ]);
    expect(result.diagnostics).toMatchObject({
      strategy: "fallback",
      fallbackReason: "timeout",
      selectedCount: 5,
    });
  });
});
