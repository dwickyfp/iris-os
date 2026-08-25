import "server-only";

import type { ArtifactReference } from "../artifacts/contracts";
import type { CapabilityResultProjectionContext } from "./capability-invoker";
import {
  fitsInlineResultSurface,
  type ResultOwnership,
  type ResultProvenance,
  type ResultSource,
  ResultSurfaceManager,
  type ResultSurfaceManagerOptions,
  type ResultSurfaceStore,
  type ResultTrust,
  type StructuredResultSummary,
} from "./result-surface";

type ArtifactCreator = {
  create(input: {
    content: string;
    filename: string;
    mediaType: string;
    userId: string;
    runId: string;
  }): Promise<ArtifactReference>;
};

export class ArtifactResultSurfaceStore implements ResultSurfaceStore {
  constructor(
    private readonly artifacts: ArtifactCreator,
    private readonly downloadUrl = (artifactId: string) =>
      `/api/artifacts/${artifactId}`,
  ) {}

  async put(source: ResultSource) {
    if (!source.ownership.runId) {
      throw new Error("Result artifacts require a runId");
    }
    const safeSourceId = source.id
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 120);
    const artifact = await this.artifacts.create({
      content: source.content,
      filename: `result-${safeSourceId}.json`,
      mediaType: source.mediaType ?? "application/json",
      userId: source.ownership.userId,
      runId: source.ownership.runId,
    });
    return {
      key: artifact.storageKey,
      uri: this.downloadUrl(artifact.artifactId),
      artifact,
    };
  }
}

export type ServerResultSurfaceInput<T> = {
  result: T;
  sourceId: string;
  userId: string;
  runId: string;
  workspaceId?: string;
  taskId?: string;
  agentId?: string;
  trust?: ResultTrust;
  provenance?: ResultProvenance[];
};

export type StoredServerResultSurface = {
  mode: "inline" | "pruned" | "structured-summary" | "reference";
  preview?: string;
  omittedBytes?: number;
  summary?: StructuredResultSummary;
  artifact: ArtifactReference;
  downloadUrl: string;
  ownership: ResultOwnership;
  trust: ResultTrust;
  provenance: ResultProvenance[];
};

export function createServerResultSurfaceProjector(
  artifacts: ArtifactCreator,
  options: ResultSurfaceManagerOptions = {},
) {
  const manager = new ResultSurfaceManager(
    new ArtifactResultSurfaceStore(artifacts),
    options,
  );

  return async function projectServerResultSurface<T>(
    input: ServerResultSurfaceInput<T>,
  ): Promise<T | StoredServerResultSurface> {
    const serialized = JSON.stringify(input.result);
    if (serialized === undefined || fitsInlineResultSurface(serialized, options)) {
      return input.result;
    }

    const ownership: ResultOwnership = {
      userId: input.userId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      agentId: input.agentId,
    };
    const trust = input.trust ?? "untrusted";
    const provenance = input.provenance ?? [
      {
        sourceId: input.sourceId,
        sourceType: "capability-result",
      },
    ];
    const surface = await manager.project({
      id: input.sourceId,
      content: serialized,
      mediaType: "application/json",
      ownership,
      trust,
      provenance,
    });
    const artifact = surface.ref.artifact;
    if (!artifact || !surface.ref.uri) {
      throw new Error("Result surface store did not return an artifact reference");
    }
    const common = {
      mode: surface.mode,
      artifact,
      downloadUrl: surface.ref.uri,
      ownership,
      trust,
      provenance,
    };

    if (surface.mode === "inline") {
      return { ...common, preview: surface.content };
    }
    if (surface.mode === "pruned") {
      return {
        ...common,
        preview: surface.content,
        omittedBytes: surface.omittedBytes,
      };
    }
    if (surface.mode === "structured-summary") {
      return { ...common, summary: surface.summary };
    }
    return { ...common, preview: serialized.slice(0, 512) };
  };
}

export function createCapabilityResultSurfaceProjector(
  artifacts: ArtifactCreator,
  options: ResultSurfaceManagerOptions = {},
) {
  const project = createServerResultSurfaceProjector(artifacts, options);
  return (result: unknown, context: CapabilityResultProjectionContext) =>
    project({
      result,
      sourceId: context.invocationId,
      userId: context.runtimeContext.userId,
      runId: context.runtimeContext.runId,
      workspaceId: context.runtimeContext.workspaceId,
      taskId: context.runtimeContext.taskId,
      agentId: context.runtimeContext.agentId,
      trust: "untrusted",
      provenance: [
        {
          sourceId: context.invocationId,
          sourceType: "capability-result",
          metadata: { capabilityId: context.capabilityId },
        },
      ],
    });
}

let productionProjector:
  | ReturnType<typeof createServerResultSurfaceProjector>
  | undefined;

/** Production projection boundary for capability results before model exposure. */
export async function projectServerResultSurface<T>(
  input: ServerResultSurfaceInput<T>,
) {
  if (!productionProjector) {
    const [{ artifactRepository }, { serverFileStorage }, { ArtifactService }] =
      await Promise.all([
        import("lib/db/repository"),
        import("lib/file-storage"),
        import("../artifacts/service"),
      ]);
    productionProjector = createServerResultSurfaceProjector(
      new ArtifactService(serverFileStorage, artifactRepository),
    );
  }
  return productionProjector(input);
}

/** Ready-to-inject production projector for `createCapabilityInvoker`. */
export function projectCapabilityResultSurface(
  result: unknown,
  context: CapabilityResultProjectionContext,
) {
  return projectServerResultSurface({
    result,
    sourceId: context.invocationId,
    userId: context.runtimeContext.userId,
    runId: context.runtimeContext.runId,
    workspaceId: context.runtimeContext.workspaceId,
    taskId: context.runtimeContext.taskId,
    agentId: context.runtimeContext.agentId,
    trust: "untrusted",
    provenance: [
      {
        sourceId: context.invocationId,
        sourceType: "capability-result",
        metadata: { capabilityId: context.capabilityId },
      },
    ],
  });
}
