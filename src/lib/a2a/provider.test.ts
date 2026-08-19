import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { createA2AProvider, normalizeA2ATask, selectA2ABinding } = await import(
  "./provider"
);

const lookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("A2A provider", () => {
  it("selects declared JSON-RPC interfaces without a silent downgrade", () => {
    expect(
      selectA2ABinding({
        name: "Current",
        url: "https://ignored.example.test/legacy",
        protocolVersion: "0.3.0",
        supportedInterfaces: [
          {
            url: "https://agent.example.test/v1",
            protocolBinding: "JSONRPC",
            protocolVersion: "1.0.0",
          },
        ],
      }),
    ).toEqual({
      url: "https://agent.example.test/v1",
      version: "1.0",
      profile: "current-1.0-jsonrpc",
    });
    expect(() =>
      selectA2ABinding({
        name: "Future",
        supportedInterfaces: [
          {
            url: "https://agent.example.test/v2",
            protocolBinding: "JSONRPC",
            protocolVersion: "2.0",
          },
        ],
      }),
    ).toThrow("no supported");
    expect(() =>
      selectA2ABinding({
        name: "Ambiguous",
        url: "https://agent.example.test/rpc",
      }),
    ).toThrow("does not declare");
  });

  it("discovers the well-known Agent Card with credentials", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({
        name: "Remote Researcher",
        url: "https://agent.example.test/a2a",
        protocolVersion: "0.3.0",
        capabilities: { streaming: false },
        skills: [],
      });
    };
    const provider = createA2AProvider({ fetch: fetcher, lookup });
    await expect(
      provider.discover("https://agent.example.test/a2a", {
        type: "bearer",
        value: "token",
      }),
    ).resolves.toMatchObject({ name: "Remote Researcher" });
    expect(calls[0].url).toBe(
      "https://agent.example.test/.well-known/agent-card.json",
    );
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(
      "Bearer token",
    );
  });

  it("propagates discovery cancellation while DNS is pending", async () => {
    const caller = new AbortController();
    const fetcher = vi.fn(async () => Response.json({}));
    const provider = createA2AProvider({
      fetch: fetcher,
      lookup: () => new Promise(() => {}),
    });
    const discovery = provider.discover(
      "https://agent.example.test/a2a",
      undefined,
      caller.signal,
    );
    caller.abort(new Error("discovery cancelled"));
    await expect(discovery).rejects.toThrow("discovery cancelled");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    {
      profile: "legacy-0.3-jsonrpc" as const,
      version: "0.3" as const,
      methods: ["message/send", "tasks/get", "tasks/cancel"],
      wrap: (task: unknown) => task,
    },
    {
      profile: "current-1.0-jsonrpc" as const,
      version: "1.0" as const,
      methods: ["SendMessage", "GetTask", "CancelTask"],
      wrap: (task: unknown) => ({ task }),
    },
  ])(
    "uses the $profile profile",
    async ({ profile, version, methods, wrap }) => {
      const calls: Array<{ method: string; version: string | null }> = [];
      const fetcher: typeof fetch = async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        calls.push({
          method: request.method,
          version: new Headers(init?.headers).get("a2a-version"),
        });
        const task = {
          id: "task-1",
          status: {
            state:
              request.method === methods[2]
                ? "TASK_STATE_CANCELED"
                : "TASK_STATE_INPUT_REQUIRED",
          },
        };
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: request.method === methods[0] ? wrap(task) : task,
        });
      };
      const provider = createA2AProvider({ fetch: fetcher, lookup });
      const binding = {
        url: "https://agent.example.test/a2a",
        profile,
        version,
      };
      await expect(
        provider.sendTask(binding, { message: { role: "user", parts: [] } }),
      ).resolves.toMatchObject({ id: "task-1", state: "input_required" });
      await provider.getTask(binding, "task-1");
      await expect(
        provider.cancelTask(binding, "task-1"),
      ).resolves.toMatchObject({
        state: "cancelled",
      });
      expect(calls).toEqual(methods.map((method) => ({ method, version })));
    },
  );

  it("accepts a direct Message send result", async () => {
    const fetcher: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          message: { role: "ROLE_AGENT", parts: [{ text: "complete" }] },
        },
      });
    };
    const provider = createA2AProvider({ fetch: fetcher, lookup });
    await expect(
      provider.sendTask(
        {
          url: "https://agent.example.test/a2a",
          profile: "current-1.0-jsonrpc",
          version: "1.0",
        },
        { message: { role: "ROLE_USER", parts: [] } },
      ),
    ).resolves.toEqual({
      kind: "message",
      message: { role: "ROLE_AGENT", parts: [{ text: "complete" }] },
    });
  });

  it("rejects malformed tasks and preserves artifact claims", () => {
    expect(() => normalizeA2ATask({ status: { state: "working" } })).toThrow(
      "valid id",
    );
    expect(
      normalizeA2ATask({
        id: "task-1",
        status: { state: "completed" },
        artifacts: { name: "not-an-array" },
      }).artifacts,
    ).toEqual([{ name: "not-an-array" }]);
  });
});
