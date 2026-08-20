import type { ArtifactReference } from "lib/ai/artifacts";

export type SandboxArtifactLimits = {
  maxInputCount: number;
  maxInputFileBytes: number;
  maxInputTotalBytes: number;
  maxOutputCount: number;
  maxOutputFileBytes: number;
  maxOutputTotalBytes: number;
};

export type SandboxArtifactInput = {
  artifactId: string;
  destination: string;
};

export type SandboxArtifactContext = {
  executionId: string;
  userId: string;
  sourceRunId: string;
  targetRunId: string;
};

export type SandboxArtifactResult = ArtifactReference & {
  relativePath: string;
};

export const DEFAULT_SANDBOX_ARTIFACT_LIMITS: SandboxArtifactLimits = {
  maxInputCount: 20,
  maxInputFileBytes: 25 * 1024 * 1024,
  maxInputTotalBytes: 100 * 1024 * 1024,
  maxOutputCount: 20,
  maxOutputFileBytes: 25 * 1024 * 1024,
  maxOutputTotalBytes: 100 * 1024 * 1024,
};
