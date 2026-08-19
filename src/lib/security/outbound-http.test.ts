import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { isPublicIpAddress, secureJsonFetch, validatePublicUrl } = await import(
  "./outbound-http"
);

const publicLookup = vi.fn(async () => [
  { address: "93.184.216.34", family: 4 },
]);

describe("outbound HTTP security", () => {
  it("requires HTTPS and rejects URL credentials", async () => {
    await expect(
      validatePublicUrl("http://example.test", { lookup: publicLookup }),
    ).rejects.toThrow("HTTPS");
    await expect(
      validatePublicUrl("https://user:pass@example.test", {
        lookup: publicLookup,
      }),
    ).rejects.toThrow("credentials");
  });

  it("blocks loopback, private, link-local, and mixed DNS answers", async () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.1.1",
      "100.64.0.1",
      "192.0.2.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
    ]) {
      expect(isPublicIpAddress(address)).toBe(false);
    }
    await expect(
      validatePublicUrl("https://example.test", {
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      }),
    ).rejects.toThrow("non-public");
  });

  it("does not forward credentials to a different redirect origin", async () => {
    const fetcher = vi.fn(async () =>
      Response.redirect("https://other.example.test/card", 302),
    );
    await expect(
      secureJsonFetch(
        "https://agent.example.test/card",
        { headers: { Authorization: "Bearer secret" } },
        { fetch: fetcher, lookup: publicLookup },
      ),
    ).rejects.toThrow("Cross-origin");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("manually validates redirect destinations before following them", async () => {
    let lookups = 0;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.redirect("https://public.test/redirected-card", 302);
    };
    await expect(
      secureJsonFetch(
        "https://public.test/card",
        {},
        {
          fetch: fetcher,
          lookup: async () => [
            {
              address: lookups++ === 0 ? "93.184.216.34" : "127.0.0.1",
              family: 4,
            },
          ],
        },
      ),
    ).rejects.toThrow("non-public");
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.redirect).toBe("manual");
  });

  it("bounds response bodies and request duration", async () => {
    await expect(
      secureJsonFetch(
        "https://example.test",
        {},
        {
          fetch: async () =>
            new Response(JSON.stringify({ tooLarge: "x".repeat(100) })),
          lookup: publicLookup,
          maxBodyBytes: 20,
        },
      ),
    ).rejects.toThrow("too large");

    await expect(
      secureJsonFetch(
        "https://example.test",
        {},
        {
          fetch: (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError")),
              );
            }),
          lookup: publicLookup,
          timeoutMs: 5,
        },
      ),
    ).rejects.toThrow("timed out");
  });

  it("applies the deadline while reading a stuck response body", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const request = secureJsonFetch(
        "https://example.test",
        {},
        {
          fetch: async () =>
            new Response(
              new ReadableStream({
                pull: () => new Promise(() => {}),
                cancel,
              }),
              { headers: { "Content-Type": "application/json" } },
            ),
          lookup: publicLookup,
          timeoutMs: 20,
        },
      );
      const expectation = expect(request).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(20);
      await expectation;
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out slow and stuck DNS resolution before fetch", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => Response.json({ ok: true }));
      const slow = secureJsonFetch(
        "https://example.test",
        {},
        {
          fetch: fetcher,
          lookup: async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return [{ address: "93.184.216.34", family: 4 }];
          },
          timeoutMs: 20,
        },
      );
      const slowExpectation = expect(slow).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(20);
      await slowExpectation;

      const stuck = secureJsonFetch(
        "https://example.test",
        {},
        {
          fetch: fetcher,
          lookup: () => new Promise(() => {}),
          timeoutMs: 20,
        },
      );
      const stuckExpectation = expect(stuck).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(20);
      await stuckExpectation;
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates caller abort while DNS resolution is pending", async () => {
    const caller = new AbortController();
    const fetcher = vi.fn(async () => Response.json({ ok: true }));
    const request = secureJsonFetch(
      "https://example.test",
      { signal: caller.signal },
      {
        fetch: fetcher,
        lookup: () => new Promise(() => {}),
        timeoutMs: 1_000,
      },
    );
    caller.abort(new Error("caller stopped during DNS"));
    await expect(request).rejects.toThrow("caller stopped during DNS");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("composes caller cancellation and uses one deadline across redirects", async () => {
    const caller = new AbortController();
    const cancelled = secureJsonFetch(
      "https://example.test",
      { signal: caller.signal },
      {
        fetch: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          }),
        lookup: publicLookup,
        timeoutMs: 1_000,
      },
    );
    caller.abort(new Error("caller stopped"));
    await expect(cancelled).rejects.toThrow("caller stopped");

    let calls = 0;
    await expect(
      secureJsonFetch(
        "https://example.test/one",
        {},
        {
          fetch: async () => {
            await new Promise((resolve) => setTimeout(resolve, 4));
            calls += 1;
            return Response.redirect(`https://example.test/${calls + 1}`, 307);
          },
          lookup: publicLookup,
          timeoutMs: 7,
          maxRedirects: 10,
        },
      ),
    ).rejects.toThrow("timed out");
    expect(calls).toBeLessThan(4);
  });

  it("shares one absolute budget across redirect DNS and fetch work", async () => {
    vi.useFakeTimers();
    try {
      let lookups = 0;
      let fetches = 0;
      const request = secureJsonFetch(
        "https://example.test/one",
        {},
        {
          lookup: async () => {
            lookups += 1;
            await new Promise((resolve) =>
              setTimeout(resolve, lookups === 1 ? 6 : 10),
            );
            return [{ address: "93.184.216.34", family: 4 }];
          },
          fetch: async () => {
            fetches += 1;
            await new Promise((resolve) => setTimeout(resolve, 6));
            return Response.redirect(
              `https://example.test/${fetches + 1}`,
              307,
            );
          },
          timeoutMs: 20,
          maxRedirects: 10,
        },
      );
      const expectation = expect(request).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(20);
      await expectation;
      expect(lookups).toBe(2);
      expect(fetches).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects successful non-JSON responses", async () => {
    await expect(
      secureJsonFetch(
        "https://example.test",
        {},
        {
          fetch: async () =>
            new Response("{}", { headers: { "Content-Type": "text/plain" } }),
          lookup: publicLookup,
        },
      ),
    ).rejects.toThrow("Content-Type");
  });
});
