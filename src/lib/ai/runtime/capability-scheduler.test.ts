import { describe, expect, test, vi } from "vitest";
import {
  type CapabilityScheduleRequest,
  CapabilityScheduler,
} from "./capability-scheduler";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function parallel<T>(execute: () => T | Promise<T>) {
  return { metadata: { concurrency: "parallel" as const }, execute };
}

function exclusive<T>(execute: () => T | Promise<T>) {
  return { metadata: { concurrency: "exclusive" as const }, execute };
}

describe("CapabilityScheduler", () => {
  test("shares admission limits across a run-scoped session", async () => {
    const gate = deferred<void>();
    let active = 0;
    const session = new CapabilityScheduler(1).createSession();
    const first = session.admit({
      metadata: { concurrency: "parallel" },
      execute: async () => {
        active++;
        await gate.promise;
        active--;
      },
    });
    const second = session.admit({
      metadata: { concurrency: "parallel" },
      execute: () => {
        active++;
        active--;
      },
    });

    await Promise.resolve();
    expect(active).toBe(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(active).toBe(0);
  });

  test("commits parallel results in request order, not completion order", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const commits: string[] = [];
    const scheduler = new CapabilityScheduler(2);

    const scheduled = scheduler.schedule(
      [parallel(() => first.promise), parallel(() => second.promise)],
      {
        onCommit(result) {
          if (result.status === "fulfilled") commits.push(result.value);
        },
      },
    );

    second.resolve("second");
    await Promise.resolve();
    expect(commits).toEqual([]);
    first.resolve("first");

    await expect(scheduled).resolves.toEqual([
      { status: "fulfilled", value: "first" },
      { status: "fulfilled", value: "second" },
    ]);
    expect(commits).toEqual(["first", "second"]);
  });

  test("does not exceed max concurrency", async () => {
    const gates = Array.from({ length: 4 }, () => deferred<number>());
    let active = 0;
    let peak = 0;
    const requests = gates.map((gate) =>
      parallel(async () => {
        active++;
        peak = Math.max(peak, active);
        const value = await gate.promise;
        active--;
        return value;
      }),
    );

    const scheduled = new CapabilityScheduler(2).schedule(requests);
    await Promise.resolve();
    expect(active).toBe(2);

    gates[0].resolve(0);
    gates[1].resolve(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(active).toBe(2);

    gates[2].resolve(2);
    gates[3].resolve(3);
    await scheduled;
    expect(peak).toBe(2);
  });

  test("uses exclusive requests as barriers between parallel groups", async () => {
    const first = deferred<void>();
    const exclusiveStarted = deferred<void>();
    const exclusiveGate = deferred<void>();
    const events: string[] = [];
    const requests = [
      parallel(async () => {
        events.push("parallel-before:start");
        await first.promise;
        events.push("parallel-before:end");
      }),
      exclusive(async () => {
        events.push("exclusive:start");
        exclusiveStarted.resolve();
        await exclusiveGate.promise;
        events.push("exclusive:end");
      }),
      parallel(() => {
        events.push("parallel-after:start");
      }),
    ];

    const scheduled = new CapabilityScheduler(3).schedule(requests);
    await Promise.resolve();
    expect(events).toEqual(["parallel-before:start"]);

    first.resolve();
    await exclusiveStarted.promise;
    expect(events).toEqual([
      "parallel-before:start",
      "parallel-before:end",
      "exclusive:start",
    ]);

    exclusiveGate.resolve();
    await scheduled;
    expect(events).toEqual([
      "parallel-before:start",
      "parallel-before:end",
      "exclusive:start",
      "exclusive:end",
      "parallel-after:start",
    ]);
  });

  test("stops admission on cancellation and marks every unstarted request skipped", async () => {
    const controller = new AbortController();
    const gate = deferred<string>();
    const started: number[] = [];
    const requests: CapabilityScheduleRequest<string>[] = [0, 1, 2].map(
      (index) =>
        parallel(async () => {
          started.push(index);
          return index === 0 ? gate.promise : String(index);
        }),
    );

    const scheduled = new CapabilityScheduler(1).schedule(requests, {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    gate.resolve("zero");

    await expect(scheduled).resolves.toEqual([
      { status: "fulfilled", value: "zero" },
      { status: "skipped", reason: "cancelled" },
      { status: "skipped", reason: "cancelled" },
    ]);
    expect(started).toEqual([0]);
  });

  test("preserves failures in order and continues later scheduling", async () => {
    const error = new Error("failed");
    const later = vi.fn(() => "later");
    const commits: string[] = [];

    const results = await new CapabilityScheduler(2).schedule(
      [
        parallel(() => "first"),
        parallel(() => Promise.reject(error)),
        exclusive(later),
      ],
      {
        onCommit(result) {
          commits.push(result.status);
        },
      },
    );

    expect(results).toEqual([
      { status: "fulfilled", value: "first" },
      { status: "rejected", error },
      { status: "fulfilled", value: "later" },
    ]);
    expect(commits).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(later).toHaveBeenCalledOnce();
  });

  test("rejects invalid concurrency bounds", () => {
    expect(() => new CapabilityScheduler(0)).toThrow(RangeError);
    expect(() => new CapabilityScheduler(1.5)).toThrow(
      "maxConcurrency must be a positive integer",
    );
  });
});
