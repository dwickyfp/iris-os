import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import type { ArtifactReference } from "../artifacts/contracts";
import {
  ArtifactResultSurfaceStore,
  createCapabilityResultSurfaceProjector,
  createServerResultSurfaceProjector,
} from "./result-surface.server";

vi.mock("server-only", () => ({}));

const artifact: ArtifactReference = {
  artifactId: randomUUID(),
  storageKey: "artifacts/result.json",
  filename: "result.json",
  mediaType: "application/json",
  size: 100,
  sha256: "a".repeat(64),
};

function artifactCreator() {
  return {
    create: vi.fn(async () => artifact),
  };
}

const thresholds = {
  thresholds: {
    inline: { maxBytes: 20, maxTokens: 5 },
    pruned: { maxBytes: 80, maxTokens: 20 },
    structuredSummary: { maxBytes: 200, maxTokens: 50 },
  },
};

describe("server ResultSurface projection", () => {
  test("returns small results unchanged without creating an artifact", async () => {
    const artifacts = artifactCreator();
    const project = createServerResultSurfaceProjector(artifacts, thresholds);
    const result = { ok: true };

    await expect(
      project({
        result,
        sourceId: "call-1",
        userId: "user-1",
        runId: "run-1",
      }),
    ).resolves.toBe(result);
    expect(artifacts.create).not.toHaveBeenCalled();
  });

  test("persists large JSON and returns a bounded untrusted projection", async () => {
    const artifacts = artifactCreator();
    const project = createServerResultSurfaceProjector(artifacts, thresholds);
    const result = { rows: Array.from({ length: 30 }, (_, id) => ({ id })) };
    const provenance = [
      { sourceId: "tool-call-1", sourceType: "capability-result" },
    ];

    const projected = await project({
      result,
      sourceId: "call-1",
      userId: "user-1",
      runId: "run-1",
      workspaceId: "workspace-1",
      provenance,
    });

    expect(artifacts.create).toHaveBeenCalledOnce();
    expect(artifacts.create).toHaveBeenCalledWith({
      content: JSON.stringify(result),
      filename: "result-call-1.json",
      mediaType: "application/json",
      userId: "user-1",
      runId: "run-1",
    });
    expect(projected).toMatchObject({
      mode: "reference",
      artifact,
      downloadUrl: `/api/artifacts/${artifact.artifactId}`,
      ownership: {
        userId: "user-1",
        runId: "run-1",
        workspaceId: "workspace-1",
      },
      trust: "untrusted",
      provenance,
    });
    expect("result" in (projected as object)).toBe(false);
    expect(
      (projected as { preview: string }).preview.length,
    ).toBeLessThanOrEqual(512);
  });

  test("preserves explicit mixed trust in a structured summary", async () => {
    const artifacts = artifactCreator();
    const project = createServerResultSurfaceProjector(artifacts, {
      thresholds: {
        inline: { maxBytes: 1, maxTokens: 1 },
        pruned: { maxBytes: 2, maxTokens: 2 },
        structuredSummary: { maxBytes: 1_000, maxTokens: 1_000 },
      },
    });

    const projected = await project({
      result: { values: [1, 2, 3] },
      sourceId: "call-2",
      userId: "user-1",
      runId: "run-1",
      trust: "mixed",
    });

    expect(projected).toMatchObject({
      mode: "structured-summary",
      trust: "mixed",
      summary: {
        format: "result-summary-v1",
        structure: { type: "object", keys: ["values"] },
      },
    });
  });

  test("bounds a large JSON scalar inside a structured summary", async () => {
    const artifacts = artifactCreator();
    const project = createServerResultSurfaceProjector(artifacts, {
      thresholds: {
        inline: { maxBytes: 1, maxTokens: 1 },
        pruned: { maxBytes: 2, maxTokens: 2 },
        structuredSummary: { maxBytes: 2_000, maxTokens: 2_000 },
      },
    });

    const projected = await project({
      result: "x".repeat(1_000),
      sourceId: "call-3",
      userId: "user-1",
      runId: "run-1",
    });

    expect(projected).toMatchObject({
      mode: "structured-summary",
      trust: "untrusted",
      provenance: [{ sourceId: "call-3", sourceType: "capability-result" }],
      summary: {
        structure: {
          type: "scalar",
          value: {
            type: "string",
            characterLength: 1_000,
            preview: "x".repeat(120),
          },
        },
      },
    });
    expect(JSON.stringify(projected)).not.toContain("x".repeat(121));
  });
});

describe("ArtifactResultSurfaceStore", () => {
  test("requires run ownership before persistence", async () => {
    const artifacts = artifactCreator();
    const store = new ArtifactResultSurfaceStore(artifacts);

    await expect(
      store.put({
        id: "call-1",
        content: "{}",
        ownership: { userId: "user-1" },
        trust: "untrusted",
        provenance: [],
      }),
    ).rejects.toThrow("Result artifacts require a runId");
    expect(artifacts.create).not.toHaveBeenCalled();
  });
});

test("adapts canonical capability invocation context to provenance", async () => {
  const artifacts = artifactCreator();
  const project = createCapabilityResultSurfaceProjector(artifacts, thresholds);

  const projected = await project(
    { rows: Array.from({ length: 30 }, (_, id) => ({ id })) },
    {
      invocationId: "invocation-1",
      capabilityId: "search",
      runtimeContext: {
        requestId: "request-1",
        runId: "run-1",
        userId: "user-1",
        agentId: "agent-1",
        agentType: "custom",
        toolMode: "auto",
        approvalPolicy: "never",
        skills: [],
      },
    },
  );

  expect(projected).toMatchObject({
    trust: "untrusted",
    ownership: { userId: "user-1", runId: "run-1", agentId: "agent-1" },
    provenance: [
      {
        sourceId: "invocation-1",
        sourceType: "capability-result",
        metadata: { capabilityId: "search" },
      },
    ],
  });
});
