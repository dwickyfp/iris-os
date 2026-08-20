import { describe, expect, it, vi } from "vitest";
import { IrisRunnerProvider } from "./iris-runner-provider";

describe("IrisRunnerProvider", () => {
  it("maps provider operations onto the injected HTTP client", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ready: true })
      .mockResolvedValueOnce({
        id: "instance-1",
        profile: { id: "python", network: "none" },
        limits: {
          nanoCpus: 1_000_000_000,
          memoryBytes: 512 * 1_048_576,
          tmpfsBytes: 1_024 * 1_048_576,
          pidsLimit: 64,
          executionTimeoutMs: 1_000,
          idleTimeoutMs: 5_000,
          absoluteTimeoutMs: 15_000,
        },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 5_000).toISOString(),
      })
      .mockResolvedValueOnce({
        executionId: "execution-1",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        durationMs: 1,
        files: [],
      });
    const provider = new IrisRunnerProvider({
      request,
      uploadArchive: vi.fn(async () => undefined),
      downloadArchive: vi.fn(async () => Buffer.alloc(0)),
    });
    const profile = {
      id: "python",
      cpuMillis: 1_000,
      memoryMb: 512,
      diskMb: 1_024,
      executionTimeoutMs: 1_000,
      idleTimeoutMs: 5_000,
      network: "none" as const,
    };

    expect(await provider.status()).toMatchObject({
      ready: true,
      provider: "iris-runner",
    });
    const instance = await provider.create({
      scope: { runId: "run-1", userId: "user-1" },
      profile,
    });
    await instance.executePython({ code: "print('ok')" });

    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "POST",
        path: "/v1/sessions",
        body: {
          profile: { id: "python", network: "none" },
          limits: {
            cpuMillis: 1_000,
            memoryMb: 512,
            tmpfsMb: 1_024,
            pidsLimit: undefined,
            executionTimeoutMs: 1_000,
            idleTimeoutMs: 5_000,
            absoluteTimeoutMs: 15_000,
          },
        },
      }),
    );

    expect(request).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: "POST",
        path: "/v1/sessions/instance-1/exec",
      }),
    );
  });
});
