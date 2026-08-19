import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { ingestRemoteArtifacts } from "./remote";
import type { ArtifactService } from "./service";

const owner = { userId: randomUUID(), runId: randomUUID() };

function dependencies() {
  const create = vi.fn(async (input) => ({
    artifactId: randomUUID(),
    storageKey: `remote/${input.filename}`,
    filename: input.filename,
    mediaType: input.mediaType,
    size: Buffer.byteLength(input.content),
    sha256: "a".repeat(64),
  }));
  const verify = vi.fn(async () => ({ verified: true as const }));
  return {
    create,
    verify,
    value: {
      artifacts: { create } as unknown as ArtifactService,
      verify,
    },
  };
}

describe("remote artifact ingestion", () => {
  test("normalizes supported A2A parts into owned canonical artifacts and verifies them", async () => {
    const { create, verify, value } = dependencies();

    const artifacts = await ingestRemoteArtifacts(
      [
        { name: "summary.txt", parts: [{ kind: "text", text: "Result" }] },
        { name: "data.json", parts: [{ kind: "data", data: { total: 3 } }] },
        {
          name: "chart.png",
          parts: [
            {
              kind: "file",
              file: {
                bytes: Buffer.from("image").toString("base64"),
                mimeType: "image/png",
              },
            },
          ],
        },
      ],
      owner,
      value,
    );

    expect(artifacts).toHaveLength(3);
    expect(create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        content: "Result",
        filename: "summary.txt",
        mediaType: "text/plain",
        ...owner,
      }),
    );
    expect(create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        content: '{"total":3}',
        mediaType: "application/json",
        ...owner,
      }),
    );
    expect(create.mock.calls[2][0].content).toEqual(Buffer.from("image"));
    expect(verify).toHaveBeenCalledTimes(3);
    expect(verify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "remote_artifact",
        expectedUserId: owner.userId,
        expectedRunId: owner.runId,
      }),
    );
    expect(create).toHaveBeenCalledBefore(verify);
  });

  test.each([
    [{ name: "uri.txt", parts: [{ file: { uri: "https://example.test/a" } }] }],
    [{ name: "empty.txt", parts: [] }],
    [{ name: "mixed.txt", parts: [{ text: "a" }, { text: "b" }] }],
  ])("rejects malformed or unsupported artifact claims", async (artifact) => {
    await expect(
      ingestRemoteArtifacts([artifact], owner, dependencies().value),
    ).rejects.toThrow("REMOTE_ARTIFACT_MALFORMED");
  });

  test("rejects oversized and excessive claims before canonical creation", async () => {
    const dependency = dependencies();
    await expect(
      ingestRemoteArtifacts(
        [{ parts: [{ text: "x".repeat(5 * 1024 * 1024 + 1) }] }],
        owner,
        dependency.value,
      ),
    ).rejects.toThrow("REMOTE_ARTIFACT_TOO_LARGE");
    await expect(
      ingestRemoteArtifacts(
        Array.from({ length: 11 }, () => ({ parts: [{ text: "x" }] })),
        owner,
        dependency.value,
      ),
    ).rejects.toThrow("REMOTE_ARTIFACT_COUNT_INVALID");
    expect(dependency.create).not.toHaveBeenCalled();
  });

  test("fails when canonical verification cannot establish integrity", async () => {
    const dependency = dependencies();

    await expect(
      ingestRemoteArtifacts(
        [{ name: "result.txt", parts: [{ text: "Result" }] }],
        owner,
        {
          artifacts: dependency.value.artifacts,
          verify: vi.fn(async () => ({
            verified: false as const,
            reason: "ARTIFACT_HASH_MISMATCH",
          })),
        },
      ),
    ).rejects.toThrow("ARTIFACT_HASH_MISMATCH");
  });
});
