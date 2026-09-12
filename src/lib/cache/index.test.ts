import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

async function importCache() {
  vi.resetModules();
  return import("./index");
}

describe("serverCache backend selection", () => {
  const ORIGINAL = process.env.REDIS_URL;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = ORIGINAL;
    delete (globalThis as { __server__cache__?: unknown }).__server__cache__;
  });

  test("uses SafeRedisCache when REDIS_URL is configured", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const { serverCache } = await importCache();
    const { SafeRedisCache } = await import("./safe-redis-cache");
    expect(serverCache).toBeInstanceOf(SafeRedisCache);
  });

  test("falls back to MemoryCache without REDIS_URL", async () => {
    delete process.env.REDIS_URL;
    const { serverCache } = await importCache();
    const { MemoryCache } = await import("./memory-cache");
    expect(serverCache).toBeInstanceOf(MemoryCache);
  });
});
