import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { SandboxRunnerSessionCreateRequest } from "../sandbox/contracts";
import { parseSandboxRunnerConfig } from "./config";
import type { DockerClient, DockerStreamResponse } from "./docker";
import { SandboxRunner } from "./runner";

const image = `registry.example/iris-sandbox@sha256:${"a".repeat(64)}`;

function config(overrides: Record<string, string> = {}) {
  return parseSandboxRunnerConfig({
    SANDBOX_RUNNER_TOKEN: "t".repeat(32),
    SANDBOX_RUNNER_IMAGE: image,
    SANDBOX_RUNNER_SESSION_TTL_MS: "1000",
    ...overrides,
  } as unknown as NodeJS.ProcessEnv);
}

function sessionRequest(
  overrides: Partial<SandboxRunnerSessionCreateRequest["limits"]> = {},
): SandboxRunnerSessionCreateRequest {
  return {
    profile: { id: "python", network: "none" },
    limits: {
      cpuMillis: 1_000,
      memoryMb: 512,
      tmpfsMb: 1_024,
      pidsLimit: 128,
      executionTimeoutMs: 60_000,
      idleTimeoutMs: 300_000,
      absoluteTimeoutMs: 900_000,
      ...overrides,
    },
  };
}

type Call = { method: string; path: string; body: unknown };

class FakeDocker {
  socketPath = "/fake.sock";
  calls: Call[] = [];
  createCount = 0;
  hasRunsc = true;

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    this.calls.push({ method, path, body });
    if (path === "/info")
      return { Runtimes: this.hasRunsc ? { runsc: {} } : { runc: {} } } as T;
    if (path.startsWith("/images/")) return { RepoDigests: [image] } as T;
    if (path.startsWith("/containers/json")) return [{ Id: "stale" }] as T;
    if (path.startsWith("/containers/create"))
      return { Id: `container-${++this.createCount}` } as T;
    if (path.includes("/wait?")) return { StatusCode: 0 } as T;
    if (path.endsWith("/json")) return { State: { Status: "running" } } as T;
    return "OK" as T;
  }

  async stream(): Promise<DockerStreamResponse> {
    return { statusCode: 200, headers: {}, stream: Readable.from([]) };
  }
}

describe("SandboxRunner", () => {
  it("runs exact startup probes, startup cleanup, canary, and secure create JSON", async () => {
    const docker = new FakeDocker();
    const runner = new SandboxRunner(
      config(),
      docker as unknown as DockerClient,
    );
    await runner.start();
    const session = await runner.createSession(sessionRequest());

    expect(
      docker.calls.slice(0, 5).map(({ method, path }) => [method, path]),
    ).toEqual([
      ["GET", "/_ping"],
      ["GET", "/version"],
      ["GET", "/info"],
      ["GET", `/images/${encodeURIComponent(image)}/json`],
      ["GET", expect.stringMatching(/^\/containers\/json\?all=true&filters=/)],
    ]);
    expect(docker.calls).toContainEqual({
      method: "DELETE",
      path: "/containers/stale?force=true&v=true",
      body: undefined,
    });
    const creates = docker.calls.filter((call) =>
      call.path.startsWith("/containers/create"),
    );
    expect(creates).toHaveLength(2);
    expect(creates[1].body).toEqual({
      Image: image,
      Cmd: ["sleep", "infinity"],
      User: "10001:10001",
      WorkingDir: "/workspace",
      NetworkDisabled: true,
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      OpenStdin: false,
      StdinOnce: false,
      Tty: false,
      Labels: {
        "com.iris-os.sandbox-runner": "true",
        "com.iris-os.sandbox-session": session.id,
        "com.iris-os.sandbox-created-ms": expect.stringMatching(/^\d+$/),
      },
      HostConfig: {
        Runtime: "runsc",
        ReadonlyRootfs: true,
        NetworkMode: "none",
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: 268435456,
        MemorySwap: 268435456,
        NanoCpus: 500000000,
        PidsLimit: 64,
        OomKillDisable: false,
        Privileged: false,
        AutoRemove: false,
        Init: true,
        IpcMode: "private",
        UTSMode: "private",
        CgroupnsMode: "private",
        Binds: [],
        Mounts: [],
        Devices: [],
        DeviceRequests: [],
        Tmpfs: {
          "/tmp":
            "rw,noexec,nosuid,nodev,size=67108864,uid=10001,gid=10001,mode=700",
          "/workspace":
            "rw,noexec,nosuid,nodev,size=67108864,uid=10001,gid=10001,mode=700",
        },
      },
    });
    await runner.stop();
  });

  it("fails closed with RUNSC_UNAVAILABLE and never creates a container", async () => {
    const docker = new FakeDocker();
    docker.hasRunsc = false;
    const runner = new SandboxRunner(
      config(),
      docker as unknown as DockerClient,
    );
    await expect(runner.start()).rejects.toMatchObject({
      code: "RUNSC_UNAVAILABLE",
    });
    expect(runner.readiness).toBe(false);
    expect(
      docker.calls.some((call) => call.path.startsWith("/containers/create")),
    ).toBe(false);
  });

  it("reaps expired sessions using forced deletion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const docker = new FakeDocker();
    const runner = new SandboxRunner(
      config(),
      docker as unknown as DockerClient,
    );
    await runner.start();
    const session = await runner.createSession(
      sessionRequest({ idleTimeoutMs: 1_000, absoluteTimeoutMs: 1_000 }),
    );
    await runner.reap(2_001);
    expect(docker.calls).toContainEqual({
      method: "DELETE",
      path: "/containers/container-2?force=true&v=true",
      body: undefined,
    });
    await expect(runner.getSession(session.id)).rejects.toThrow("not found");
    await runner.stop();
    vi.useRealTimers();
  });

  it("clamps and stores every per-session resource and lifetime limit", async () => {
    const docker = new FakeDocker();
    const runner = new SandboxRunner(
      config({
        SANDBOX_RUNNER_IDLE_TTL_MS: "2000",
        SANDBOX_RUNNER_SESSION_TTL_MS: "5000",
      }),
      docker as unknown as DockerClient,
    );
    await runner.start();
    const session = await runner.createSession(sessionRequest());

    expect(session.limits).toEqual({
      nanoCpus: 500_000_000,
      memoryBytes: 256 * 1024 * 1024,
      tmpfsBytes: 64 * 1024 * 1024,
      pidsLimit: 64,
      executionTimeoutMs: 30_000,
      idleTimeoutMs: 2_000,
      absoluteTimeoutMs: 5_000,
    });
    const create = docker.calls.filter((call) =>
      call.path.startsWith("/containers/create"),
    )[1].body as { HostConfig: Record<string, unknown> };
    expect(create.HostConfig).toMatchObject({
      Memory: session.limits.memoryBytes,
      MemorySwap: session.limits.memoryBytes,
      NanoCpus: session.limits.nanoCpus,
      PidsLimit: session.limits.pidsLimit,
    });

    const lower = await runner.createSession(
      sessionRequest({
        cpuMillis: 100,
        memoryMb: 32,
        tmpfsMb: 8,
        pidsLimit: 8,
        executionTimeoutMs: 1_000,
        idleTimeoutMs: 1_000,
        absoluteTimeoutMs: 2_000,
      }),
    );
    expect(lower.limits).toEqual({
      nanoCpus: 100_000_000,
      memoryBytes: 32 * 1024 * 1024,
      tmpfsBytes: 8 * 1024 * 1024,
      pidsLimit: 8,
      executionTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      absoluteTimeoutMs: 2_000,
    });
    await runner.stop();
  });

  it("refreshes idle TTL on activity without extending absolute TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const docker = new FakeDocker();
    const runner = new SandboxRunner(
      config({
        SANDBOX_RUNNER_IDLE_TTL_MS: "2000",
        SANDBOX_RUNNER_SESSION_TTL_MS: "5000",
      }),
      docker as unknown as DockerClient,
    );
    await runner.start();
    const session = await runner.createSession(
      sessionRequest({ idleTimeoutMs: 2_000, absoluteTimeoutMs: 5_000 }),
    );

    vi.setSystemTime(2_500);
    await runner.exec(session.id, ["true"]);
    await runner.reap(3_001);
    expect(await runner.getSession(session.id)).toMatchObject({
      id: session.id,
    });

    vi.setSystemTime(4_500);
    await runner.exec(session.id, ["true"]);
    await runner.reap(6_001);
    await expect(runner.getSession(session.id)).rejects.toThrow("not found");
    await runner.stop();
    vi.useRealTimers();
  });

  it("attaches egress sessions only to the configured control network", async () => {
    const docker = new FakeDocker();
    const runner = new SandboxRunner(
      config({ SANDBOX_RUNNER_EGRESS_NETWORK: "sandbox-control" }),
      docker as unknown as DockerClient,
    );
    await runner.start();
    await runner.createSession({
      ...sessionRequest(),
      profile: { id: "python-egress", network: "egress" },
    });
    const create = docker.calls.filter((call) =>
      call.path.startsWith("/containers/create"),
    )[1].body as {
      NetworkDisabled: boolean;
      HostConfig: { NetworkMode: string };
    };
    expect(create.NetworkDisabled).toBe(false);
    expect(create.HostConfig.NetworkMode).toBe("sandbox-control");
    await runner.stop();
  });

  it("reserves concurrent-session capacity before asynchronous Docker creation", async () => {
    let releaseCreate: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const docker = new FakeDocker();
    const original = docker.request.bind(docker);
    docker.request = async <T = unknown>(
      method: string,
      path: string,
      body?: unknown,
    ) => {
      if (path.startsWith("/containers/create") && docker.createCount === 1) {
        await blocked;
      }
      return original<T>(method, path, body);
    };
    const runner = new SandboxRunner(
      config({ SANDBOX_RUNNER_MAX_CONCURRENT_SESSIONS: "1" }),
      docker as unknown as DockerClient,
    );
    await runner.start();

    const first = runner.createSession(sessionRequest());
    await vi.waitFor(() => expect(docker.createCount).toBe(1));
    await expect(runner.createSession(sessionRequest())).rejects.toThrow(
      "Maximum concurrent sessions",
    );
    releaseCreate?.();
    await first;
    await runner.stop();
  });
});
