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
    identity: {
      sessionId: "00000000-0000-4000-8000-000000000001",
      rootRunId: "00000000-0000-4000-8000-000000000002",
    },
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
  execOutput: Readable = Readable.from([]);
  execStatus = 200;
  execInspect: unknown = { ExitCode: 0, Running: false };
  inspectError?: Error;
  removeFailures = 0;
  containers: Array<{
    Id: string;
    Labels?: Record<string, string>;
    State?: string | { Running?: boolean; Status?: string };
  }> = [{ Id: "stale" }];

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    this.calls.push({ method, path, body });
    if (method === "DELETE" && this.removeFailures > 0) {
      this.removeFailures -= 1;
      throw new Error("remove failed");
    }
    if (path === "/info")
      return { Runtimes: this.hasRunsc ? { runsc: {} } : { runc: {} } } as T;
    if (path.startsWith("/images/")) return { RepoDigests: [image] } as T;
    if (path.startsWith("/containers/json")) return this.containers as T;
    if (path.startsWith("/containers/create"))
      return { Id: `container-${++this.createCount}` } as T;
    if (path.includes("/wait?")) return { StatusCode: 0 } as T;
    if (path.match(/^\/containers\/[^/]+\/exec$/)) {
      return { Id: "exec-1" } as T;
    }
    if (path.startsWith("/exec/") && path.endsWith("/json")) {
      if (this.inspectError) throw this.inspectError;
      return this.execInspect as T;
    }
    if (path.endsWith("/json")) return { State: { Status: "running" } } as T;
    return "OK" as T;
  }

  async stream(_method?: string, path?: string): Promise<DockerStreamResponse> {
    if (path?.endsWith("/start")) {
      return {
        statusCode: this.execStatus,
        headers: {},
        stream: this.execOutput,
      };
    }
    return { statusCode: 200, headers: {}, stream: Readable.from([]) };
  }
}

function execFrame(stream: number, value: string) {
  const body = Buffer.from(value);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

async function runnerWithSession(docker: FakeDocker, overrides = {}) {
  const runner = new SandboxRunner(
    config(overrides),
    docker as unknown as DockerClient,
  );
  await runner.start();
  const session = await runner.createSession(sessionRequest());
  docker.calls.length = 0;
  return { runner, session };
}

describe("SandboxRunner", () => {
  it("runs exact startup probes, startup inventory, canary, and secure create JSON", async () => {
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
        "com.iris-os.control-session": "00000000-0000-4000-8000-000000000001",
        "com.iris-os.root-run": "00000000-0000-4000-8000-000000000002",
        "com.iris-os.runner-boot": runner.bootId,
        "com.iris-os.sandbox-profile": "python",
        "com.iris-os.sandbox-network": "none",
        "com.iris-os.sandbox-limits": JSON.stringify(session.limits),
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

  it("labels security-run sessions for exact workflow cleanup", async () => {
    const docker = new FakeDocker();
    const runner = new SandboxRunner(
      config({ SANDBOX_SECURITY_RUN_ID: "iris-security-123-1" }),
      docker as unknown as DockerClient,
    );
    await runner.start();
    const session = await runner.createSession(sessionRequest());
    const create = docker.calls.find(
      (call) =>
        call.path.startsWith("/containers/create") &&
        (call.body as { Labels?: Record<string, string> }).Labels?.[
          "com.iris-os.sandbox-session"
        ] === session.id,
    );

    expect(
      (create?.body as { Labels: Record<string, string> }).Labels[
        "iris.security.run"
      ],
    ).toBe("iris-security-123-1");
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

  it("adopts valid owned sessions across runner boot without deleting them", async () => {
    const docker = new FakeDocker();
    docker.containers = [];
    const first = new SandboxRunner(
      config(),
      docker as unknown as DockerClient,
    );
    await first.start();
    const created = await first.createSession(sessionRequest());
    const create = docker.calls.find(
      (call) =>
        call.path.startsWith("/containers/create") &&
        (call.body as { Labels?: Record<string, string> }).Labels?.[
          "com.iris-os.sandbox-session"
        ] === created.id,
    )!;
    docker.containers = [
      {
        Id: created.containerId,
        Labels: (create.body as { Labels: Record<string, string> }).Labels,
        State: "running",
      },
    ];
    docker.calls.length = 0;

    const restarted = new SandboxRunner(
      config(),
      docker as unknown as DockerClient,
    );
    await restarted.start();

    expect(restarted.inventory()).toMatchObject({
      bootId: restarted.bootId,
      sessions: [
        {
          id: created.id,
          controlPlaneSessionId: sessionRequest().identity.sessionId,
          rootRunId: sessionRequest().identity.rootRunId,
          bootId: first.bootId,
          state: "live",
          profile: sessionRequest().profile,
          limits: created.limits,
          createdAt: new Date(created.createdAt).toISOString(),
          expiresAt: expect.any(String),
        },
      ],
    });
    expect(docker.calls).not.toContainEqual({
      method: "DELETE",
      path: `/containers/${created.containerId}?force=true&v=true`,
      body: undefined,
    });
    await restarted.stop();
    await first.stop();
    expect(docker.calls).not.toContainEqual({
      method: "DELETE",
      path: `/containers/${created.containerId}?force=true&v=true`,
      body: undefined,
    });
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

  it("attaches networked sessions only to the configured child-broker network", async () => {
    const docker = new FakeDocker();
    const runner = new SandboxRunner(
      config({
        SANDBOX_RUNNER_CHILD_BROKER_NETWORK: "sandbox-child-broker",
      }),
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
    expect(create.HostConfig.NetworkMode).toBe("sandbox-child-broker");
    await runner.stop();
  });

  it("rejects networked sessions when no child-broker network is configured", async () => {
    const docker = new FakeDocker();
    const runner = new SandboxRunner(
      config(),
      docker as unknown as DockerClient,
    );
    await runner.start();

    await expect(
      runner.createSession({
        ...sessionRequest(),
        profile: { id: "python-egress", network: "egress" },
      }),
    ).rejects.toThrow("Child-broker network is not configured");
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

  it.each([
    [
      "output overflow",
      (docker: FakeDocker) => {
        docker.execOutput = Readable.from(execFrame(1, "12345"));
      },
    ],
    [
      "malformed multiplex",
      (docker: FakeDocker) => {
        docker.execOutput = Readable.from(execFrame(3, "x"));
      },
    ],
    [
      "truncated multiplex",
      (docker: FakeDocker) => {
        docker.execOutput = Readable.from(execFrame(1, "x").subarray(0, 8));
      },
    ],
    [
      "stream error",
      (docker: FakeDocker) => {
        docker.execOutput = new Readable({
          read() {
            this.destroy(new Error("stream failed"));
          },
        });
      },
    ],
    [
      "inspect failure",
      (docker: FakeDocker) => {
        docker.inspectError = new Error("inspect failed");
      },
    ],
    [
      "still running",
      (docker: FakeDocker) => {
        docker.execInspect = { ExitCode: 0, Running: true };
      },
    ],
    [
      "inconsistent inspection",
      (docker: FakeDocker) => {
        docker.execInspect = { ExitCode: null, Running: false };
      },
    ],
    [
      "non-success start response",
      (docker: FakeDocker) => {
        docker.execStatus = 500;
      },
    ],
  ] as const)("quarantines and removes after %s", async (_name, arrange) => {
    const docker = new FakeDocker();
    const { runner, session } = await runnerWithSession(docker, {
      SANDBOX_RUNNER_MAX_EXEC_OUTPUT_BYTES: "4",
    });
    arrange(docker);

    await expect(runner.exec(session.id, ["true"])).rejects.toThrow();
    expect(docker.calls).toContainEqual({
      method: "DELETE",
      path: "/containers/container-2?force=true&v=true",
      body: undefined,
    });
    await expect(runner.getSession(session.id)).rejects.toThrow("not found");
    await runner.stop();
  });

  it("quarantines timeout and caller abort failures", async () => {
    for (const abort of [false, true]) {
      const docker = new FakeDocker();
      const { runner, session } = await runnerWithSession(docker);
      const controller = new AbortController();
      docker.stream = async (
        _method?: string,
        path?: string,
        _body?: unknown,
        signal?: AbortSignal,
      ) => {
        if (!path?.endsWith("/start")) {
          return { statusCode: 200, headers: {}, stream: Readable.from([]) };
        }
        const stream = new Readable({ read() {} });
        const fail = () => stream.destroy(new Error("aborted"));
        if (signal?.aborted) setImmediate(fail);
        else signal?.addEventListener("abort", fail, { once: true });
        return { statusCode: 200, headers: {}, stream };
      };

      const execution = runner.exec(
        session.id,
        ["sleep", "1"],
        controller.signal,
        100,
      );
      if (abort) controller.abort();
      await expect(execution).rejects.toThrow(
        abort ? "destroyed" : "timed out",
      );
      await expect(runner.getSession(session.id)).rejects.toThrow("not found");
      await runner.stop();
    }
  });

  it("retains failed removal for reaper retry", async () => {
    const docker = new FakeDocker();
    const { runner, session } = await runnerWithSession(docker);
    docker.execOutput = Readable.from(execFrame(3, "x"));
    docker.removeFailures = 1;

    await expect(runner.exec(session.id, ["true"])).rejects.toThrow("Invalid");
    await expect(runner.getSession(session.id)).rejects.toThrow("not found");
    expect(
      docker.calls.filter((call) => call.method === "DELETE"),
    ).toHaveLength(1);

    await runner.reap();
    expect(
      docker.calls.filter((call) => call.method === "DELETE"),
    ).toHaveLength(2);
    await runner.stop();
  });

  it("reuses a session after a known terminal nonzero exit", async () => {
    const docker = new FakeDocker();
    const { runner, session } = await runnerWithSession(docker);
    docker.execInspect = { ExitCode: 7, Running: false };
    docker.execOutput = Readable.from(execFrame(2, "failed"));

    await expect(runner.exec(session.id, ["false"])).resolves.toMatchObject({
      exitCode: 7,
      stderr: "failed",
    });
    await expect(runner.getSession(session.id)).resolves.toMatchObject({
      id: session.id,
    });
    expect(docker.calls.some((call) => call.method === "DELETE")).toBe(false);
    await runner.stop();
  });
});
