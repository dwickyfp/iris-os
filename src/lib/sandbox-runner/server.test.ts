import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FetchIrisRunnerHttpClient,
  IrisRunnerProvider,
} from "../sandbox/iris-runner-provider";
import { parseSandboxRunnerConfig } from "./config";
import type { DockerClient } from "./docker";
import { SandboxRunner } from "./runner";
import { createSandboxRunnerServer } from "./server";

const servers: ReturnType<typeof createSandboxRunnerServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function serve(ready: boolean) {
  const token = "secret".repeat(6);
  const runner = {
    config: parseSandboxRunnerConfig({
      SANDBOX_RUNNER_TOKEN: token,
      SANDBOX_RUNNER_IMAGE: `example/sandbox@sha256:${"b".repeat(64)}`,
    } as unknown as NodeJS.ProcessEnv),
    readiness: ready,
    inventory: vi.fn(() => ({
      bootId: "00000000-0000-4000-8000-000000000001",
      capturedAt: "2026-08-22T10:00:00.000Z",
      sessions: [],
    })),
    createSession: vi.fn(async () => ({
      id: "x".repeat(32),
      profile: { id: "python", network: "none" },
      limits: {
        nanoCpus: 1,
        memoryBytes: 1,
        tmpfsBytes: 1,
        pidsLimit: 1,
        executionTimeoutMs: 100,
        idleTimeoutMs: 1_000,
        absoluteTimeoutMs: 1_000,
      },
      createdAt: 0,
      lastUsedAt: 0,
    })),
  } as unknown as SandboxRunner;
  const server = createSandboxRunnerServer(runner);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, token, runner };
}

describe("sandbox runner HTTP auth and readiness", () => {
  it("keeps only liveness public and requires exact bearer auth", async () => {
    const { base, token } = await serve(true);
    expect(await (await fetch(`${base}/live`)).json()).toEqual({
      status: "ok",
    });
    const unauthorized = await fetch(`${base}/ready`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");
    expect(
      (
        await fetch(`${base}/ready`, {
          headers: { Authorization: `bearer ${token}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${base}/ready`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
  });

  it("requires bearer auth for non-PII runner inventory", async () => {
    const { base, token, runner } = await serve(true);
    vi.mocked(runner.inventory).mockReturnValue({
      bootId: "00000000-0000-4000-8000-000000000001",
      capturedAt: "2026-08-22T10:00:00.000Z",
      sessions: [],
    });
    expect((await fetch(`${base}/v1/inventory`)).status).toBe(401);
    const response = await fetch(`${base}/v1/inventory`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      bootId: "00000000-0000-4000-8000-000000000001",
      capturedAt: "2026-08-22T10:00:00.000Z",
      sessions: [],
    });
  });

  it("reports RUNSC_UNAVAILABLE and blocks session creation while unready", async () => {
    const { base, token, runner } = await serve(false);
    const headers = { Authorization: `Bearer ${token}` };
    const readiness = await fetch(`${base}/ready`, { headers });
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual({
      ready: false,
      reason: "RUNSC_UNAVAILABLE",
    });
    const creation = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers,
    });
    expect(creation.status).toBe(503);
    expect(runner.createSession).not.toHaveBeenCalled();
  });

  it("uses one readiness and session-create contract through provider and runner", async () => {
    const token = "provider-runner-contract-token-0123456789";
    let creates = 0;
    const docker = {
      request: vi.fn(async (_method: string, path: string) => {
        if (path === "/info") return { Runtimes: { runsc: {} } };
        if (path.startsWith("/images/")) {
          return {
            RepoDigests: [`example/sandbox@sha256:${"b".repeat(64)}`],
          };
        }
        if (path.startsWith("/containers/json")) return [];
        if (path.startsWith("/containers/create")) {
          creates += 1;
          return { Id: `container-${creates}` };
        }
        if (path.includes("/wait?")) return { StatusCode: 0 };
        return "OK";
      }),
      stream: vi.fn(async () => ({
        statusCode: 200,
        headers: {},
        stream: Readable.from([]),
      })),
    } as unknown as DockerClient;
    const runner = new SandboxRunner(
      parseSandboxRunnerConfig({
        SANDBOX_RUNNER_TOKEN: token,
        SANDBOX_RUNNER_IMAGE: `example/sandbox@sha256:${"b".repeat(64)}`,
      } as unknown as NodeJS.ProcessEnv),
      docker,
    );
    await runner.start();
    const server = createSandboxRunnerServer(runner);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const provider = new IrisRunnerProvider(
      new FetchIrisRunnerHttpClient(`http://127.0.0.1:${port}`, token),
    );
    const profile = {
      id: "python",
      cpuMillis: 1_000,
      memoryMb: 512,
      diskMb: 1_024,
      pidsLimit: 128,
      executionTimeoutMs: 60_000,
      idleTimeoutMs: 300_000,
      absoluteTimeoutMs: 900_000,
      network: "none" as const,
    };

    expect(await provider.status()).toMatchObject({ ready: true });
    const instance = await provider.create({
      scope: {
        runId: "00000000-0000-4000-8000-000000000001",
        userId: "user-1",
      },
      profile,
      sessionId: "00000000-0000-4000-8000-000000000002",
      rootRunId: "00000000-0000-4000-8000-000000000001",
    });
    expect(instance.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    await runner.stop();
  });
});
