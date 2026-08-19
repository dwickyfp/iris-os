import type { Verifier } from "../runtime/verification";
import type { ArtifactReference } from "./contracts";
import type { ArtifactService } from "./service";

const MAX_REMOTE_ARTIFACTS = 10;
const MAX_REMOTE_ARTIFACT_BYTES = 5 * 1024 * 1024;

type NormalizedRemoteArtifact = {
  content: Buffer | string;
  filename: string;
  mediaType: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function filename(value: unknown, index: number, extension: string) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return candidate &&
    candidate.length <= 240 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(candidate)
    ? candidate
    : `remote-artifact-${index + 1}.${extension}`;
}

function bounded(content: Buffer | string) {
  if (Buffer.byteLength(content) > MAX_REMOTE_ARTIFACT_BYTES) {
    throw new Error("REMOTE_ARTIFACT_TOO_LARGE");
  }
  return content;
}

function normalizeRemoteArtifact(
  value: unknown,
  index: number,
): NormalizedRemoteArtifact {
  const artifact = record(value);
  if (
    !artifact ||
    !Array.isArray(artifact.parts) ||
    artifact.parts.length !== 1
  ) {
    throw new Error("REMOTE_ARTIFACT_MALFORMED");
  }
  const part = record(artifact.parts[0]);
  if (!part) throw new Error("REMOTE_ARTIFACT_MALFORMED");

  if (typeof part.text === "string" && part.text.length > 0) {
    return {
      content: bounded(part.text),
      filename: filename(artifact.name ?? artifact.artifactId, index, "txt"),
      mediaType: "text/plain",
    };
  }
  if ("data" in part) {
    const data = JSON.stringify(part.data);
    if (data === undefined) throw new Error("REMOTE_ARTIFACT_MALFORMED");
    return {
      content: bounded(data),
      filename: filename(artifact.name ?? artifact.artifactId, index, "json"),
      mediaType: "application/json",
    };
  }
  const file = record(part.file);
  if (!file || typeof file.bytes !== "string" || !file.bytes) {
    throw new Error("REMOTE_ARTIFACT_MALFORMED");
  }
  if (
    file.bytes.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(file.bytes)
  ) {
    throw new Error("REMOTE_ARTIFACT_MALFORMED");
  }
  const content = bounded(Buffer.from(file.bytes, "base64"));
  const mediaType =
    typeof file.mimeType === "string" &&
    file.mimeType.length <= 160 &&
    /^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType)
      ? file.mimeType
      : "application/octet-stream";
  return {
    content,
    filename: filename(file.name ?? artifact.name, index, "bin"),
    mediaType,
  };
}

export async function ingestRemoteArtifacts(
  claimed: unknown[],
  owner: { userId: string; runId: string },
  dependencies: { artifacts: ArtifactService; verify: Verifier["verify"] },
): Promise<ArtifactReference[]> {
  if (claimed.length === 0 || claimed.length > MAX_REMOTE_ARTIFACTS) {
    throw new Error("REMOTE_ARTIFACT_COUNT_INVALID");
  }
  const normalized = claimed.map(normalizeRemoteArtifact);
  const canonical: ArtifactReference[] = [];
  for (const artifact of normalized) {
    const reference = await dependencies.artifacts.create({
      ...artifact,
      ...owner,
    });
    const result = await dependencies.verify({
      kind: "remote_artifact",
      value: reference,
      mediaType: reference.mediaType,
      expectedUserId: owner.userId,
      expectedRunId: owner.runId,
    });
    if (!result.verified) throw new Error(result.reason);
    canonical.push(reference);
  }
  return canonical;
}
