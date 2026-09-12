import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { checkRateLimit, resetRateLimits, sweepRateLimits } from "./rate-limit";

describe("checkRateLimit", () => {
  beforeEach(() => resetRateLimits());

  test("allows up to the limit then rejects with retry hint", () => {
    let now = 1_000_000;
    for (let i = 0; i < 3; i++) {
      const result = checkRateLimit("chat", "u1", 3, 60_000, now);
      expect(result.allowed).toBe(true);
    }
    const blocked = checkRateLimit("chat", "u1", 3, 60_000, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);

    // A fresh window allows again.
    now += 60_001;
    expect(checkRateLimit("chat", "u1", 3, 60_000, now).allowed).toBe(true);
  });

  test("isolates buckets and keys", () => {
    expect(checkRateLimit("chat", "u1", 1, 60_000).allowed).toBe(true);
    expect(checkRateLimit("chat", "u2", 1, 60_000).allowed).toBe(true);
    expect(checkRateLimit("upload", "u1", 1, 60_000).allowed).toBe(true);
    expect(checkRateLimit("chat", "u1", 1, 60_000).allowed).toBe(false);
  });

  test("sweep clears idle entries", () => {
    checkRateLimit("chat", "idle-user", 5, 60_000, 1);
    sweepRateLimits(1 + 10 * 60_000);
    // Internal state cleared: the same key gets a fresh window.
    expect(
      checkRateLimit("chat", "idle-user", 5, 60_000, 1 + 10 * 60_000 + 1)
        .allowed,
    ).toBe(true);
  });
});
