import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, pgDb, requestCancellation, getRunTrajectory } = vi.hoisted(
  () => ({
    getSession: vi.fn(),
    pgDb: { select: vi.fn() },
    requestCancellation: vi.fn(),
    getRunTrajectory: vi.fn(),
  }),
);

vi.mock("auth/server", () => ({ getSession }));
vi.mock("server-only", () => ({}));
vi.mock("lib/db/pg/db.pg", () => ({ pgDb }));
vi.mock("lib/ai/runs/server", () => ({ runManager: { requestCancellation } }));
vi.mock("lib/activity/trajectory", () => ({ getRunTrajectory }));
vi.mock("lib/delegation/service", () => ({
  DELEGATION_LIMITS: {
    maxTimeoutMs: 300_000,
    defaultTimeoutMs: 60_000,
  },
  createDelegatedRun: vi.fn(),
}));

import { POST as delegateRun } from "./[id]/delegate/route";
import { DELETE as cancelRun, GET as getRun } from "./[id]/route";
import { GET as getTimeline } from "./[id]/timeline/route";
import { GET as listRuns } from "./route";

const run = {
  id: "run-1",
  userId: "user-1",
  parentRunId: null,
  rootRunId: "run-1",
  status: "running",
};

function queueResults(...results: unknown[][]) {
  let index = 0;
  pgDb.select.mockImplementation(() => {
    const result = results[index++] ?? [];
    const query = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      orderBy: vi.fn(() => query),
      limit: vi.fn(() => query),
      then: (resolve: (value: unknown[]) => unknown) =>
        Promise.resolve(result).then(resolve),
    };
    return query;
  });
}

describe("AgentRun observability when delegation is disabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.IRIS_DELEGATION_V2 = "false";
    getSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("lists owned AgentRuns", async () => {
    queueResults([run], []);

    const response = await listRuns();

    expect(response.status).toBe(200);
    expect((await response.json()).runs).toEqual([run]);
  });

  it("gets an owned AgentRun", async () => {
    queueResults([run], [], []);

    const response = await getRun(new Request("http://localhost"), {
      params: Promise.resolve({ id: run.id }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).id).toBe(run.id);
  });

  it("gets an owned AgentRun timeline", async () => {
    queueResults([run], []);
    getRunTrajectory.mockResolvedValue([{ id: "event-1" }]);

    const response = await getTimeline(new Request("http://localhost"), {
      params: Promise.resolve({ id: run.id }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).events).toEqual([{ id: "event-1" }]);
  });

  it("cancels an owned AgentRun", async () => {
    requestCancellation.mockResolvedValue({ ...run, status: "cancelled" });

    const response = await cancelRun(new Request("http://localhost"), {
      params: Promise.resolve({ id: run.id }),
    });

    expect(response.status).toBe(200);
    expect(requestCancellation).toHaveBeenCalledWith(run.id, "user-1");
  });

  it("keeps delegated child creation disabled", async () => {
    const response = await delegateRun(
      new Request("http://localhost", { method: "POST" }),
      { params: Promise.resolve({ id: run.id }) },
    );

    expect(response.status).toBe(404);
  });
});
