import "server-only";

/**
 * In-process sliding-window rate limiter for expensive routes (LLM calls,
 * uploads, workflow executions). Per-instance by design: it bounds per-user
 * cost amplification on one node even before a shared store exists.
 * Fails open on internal errors so limiter bugs never take the app down.
 */

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
};

type Window = { hits: number[] };

const windows = new Map<string, Window>();

function prune(hits: number[], windowStart: number): number[] {
  return hits.filter((timestamp) => timestamp > windowStart);
}

export function checkRateLimit(
  bucket: string,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): RateLimitResult {
  const id = `${bucket}:${key}`;
  try {
    const windowStart = now - windowMs;
    const existing = windows.get(id);
    const hits = prune(existing?.hits ?? [], windowStart);
    if (hits.length >= limit) {
      const oldest = hits[0];
      windows.set(id, { hits });
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, oldest + windowMs - now),
      };
    }
    hits.push(now);
    windows.set(id, { hits });
    return {
      allowed: true,
      remaining: limit - hits.length,
      retryAfterMs: 0,
    };
  } catch {
    return { allowed: true, remaining: limit, retryAfterMs: 0 };
  }
}

/** Periodic cleanup so idle keys do not accumulate; called opportunistically. */
export function sweepRateLimits(now = Date.now(), maxAgeMs = 10 * 60_000) {
  for (const [id, { hits }] of windows) {
    const last = hits[hits.length - 1];
    if (last === undefined || now - last > maxAgeMs) windows.delete(id);
  }
}

export function resetRateLimits() {
  windows.clear();
}

export function rateLimitResponse(retryAfterMs: number): Response {
  return new Response(
    JSON.stringify({ error: "Too many requests. Please slow down." }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
      },
    },
  );
}
