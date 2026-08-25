import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getPlain, getSecret } = vi.hoisted(() => ({
  getPlain: vi.fn(),
  getSecret: vi.fn(),
}));

vi.mock("lib/system-settings/server", () => ({
  systemSettingsService: { getPlain, getSecret },
}));

import {
  configureExaSettingsResolver,
  exaSearchToolForWorkflow,
} from "./web-search";

const executeSearch = () =>
  exaSearchToolForWorkflow.execute!(
    { query: "iris" },
    {} as Parameters<NonNullable<typeof exaSearchToolForWorkflow.execute>>[1],
  );

describe("Exa web search settings", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    getSecret.mockReset();
    getPlain.mockReset();
    getSecret.mockResolvedValue("database-key");
    getPlain.mockResolvedValue("https://api.exa.ai");
    configureExaSettingsResolver(async () => ({
      apiKey: await getSecret("exa.apiKey"),
      baseUrl: String(await getPlain("exa.baseUrl")),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    delete process.env.EXA_API_KEY;
    vi.unstubAllGlobals();
  });

  it("resolves settings for every request without using the environment", async () => {
    process.env.EXA_API_KEY = "environment-key";

    await executeSearch();
    getSecret.mockResolvedValueOnce("rotated-database-key");
    await executeSearch();

    expect(getSecret).toHaveBeenCalledTimes(2);
    expect(getSecret).toHaveBeenCalledWith("exa.apiKey");
    expect(getPlain).toHaveBeenCalledTimes(2);
    expect(getPlain).toHaveBeenCalledWith("exa.baseUrl");
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.exa.ai/search",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-api-key": "database-key" }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.exa.ai/search",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "rotated-database-key",
        }),
      }),
    );
  });

  it("does not fall back to the environment when the secret is absent", async () => {
    process.env.EXA_API_KEY = "environment-key";
    getSecret.mockResolvedValueOnce(null);

    await expect(executeSearch()).rejects.toThrow(
      "EXA_API_KEY is not configured",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses a bounded configured base URL", async () => {
    getPlain.mockResolvedValueOnce("https://exa.example.com/v1/");

    await executeSearch();

    expect(fetch).toHaveBeenCalledWith(
      "https://exa.example.com/v1/search",
      expect.anything(),
    );
  });

  it.each([
    "",
    "file:///tmp/exa",
    `https://api.exa.ai/${"a".repeat(2048)}`,
  ])("rejects an unsafe base URL: %s", async (baseUrl) => {
    getPlain.mockResolvedValueOnce(baseUrl);

    await expect(executeSearch()).rejects.toThrow(
      "Exa API base URL is invalid",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
