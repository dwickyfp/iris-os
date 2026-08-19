import { describe, expect, it, vi } from "vitest";
import { startWorkerHeartbeat } from "./heartbeat";

const identity = {
  workerId: "worker-1",
  hostname: "host",
  pid: 123,
  version: "1.0.0",
};

describe("worker heartbeat", () => {
  it("logs interval failures and requests shutdown at the bounded threshold", async () => {
    vi.useFakeTimers();
    const error = new Error("database unavailable");
    const pool = {
      query: vi.fn().mockRejectedValue(error),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const onFailure = vi.fn();
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const heartbeat = startWorkerHeartbeat("postgres://unused", identity, 1_000, {
      maxConsecutiveFailures: 2,
      onFailure,
      onShutdown,
      pool,
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenLastCalledWith(error, 2);
    expect(onShutdown).toHaveBeenCalledOnce();
    expect(onShutdown).toHaveBeenCalledWith(error);
    await heartbeat.stop().catch(() => undefined);
    expect(pool.end).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("resets consecutive failures after a successful heartbeat", async () => {
    vi.useFakeTimers();
    const pool = {
      query: vi
        .fn()
        .mockRejectedValueOnce(new Error("first"))
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("second"))
        .mockResolvedValue({}),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const onFailure = vi.fn();
    const onShutdown = vi.fn();
    const heartbeat = startWorkerHeartbeat("postgres://unused", identity, 1_000, {
      maxConsecutiveFailures: 2,
      onFailure,
      onShutdown,
      pool,
    });

    await vi.advanceTimersByTimeAsync(3_000);

    expect(onFailure.mock.calls.map((call) => call[1])).toEqual([1, 1]);
    expect(onShutdown).not.toHaveBeenCalled();
    await heartbeat.stop();
    vi.useRealTimers();
  });

  it("bounds a stuck shutdown callback and heartbeat cleanup", async () => {
    vi.useFakeTimers();
    const pool = {
      query: vi
        .fn()
        .mockRejectedValueOnce(new Error("database unavailable"))
        .mockImplementation(() => new Promise(() => {})),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const heartbeat = startWorkerHeartbeat("postgres://unused", identity, 1_000, {
      maxConsecutiveFailures: 1,
      shutdownTimeoutMs: 20,
      onShutdown: () => new Promise(() => {}),
      pool,
    });

    const shutdownAttempt = heartbeat.start();
    await vi.advanceTimersByTimeAsync(20);
    await shutdownAttempt;

    const stop = heartbeat.stop();
    const expectation = expect(stop).rejects.toThrow(
      "Heartbeat cleanup timed out",
    );
    await vi.advanceTimersByTimeAsync(20);
    await expectation;
    vi.useRealTimers();
  });
});
