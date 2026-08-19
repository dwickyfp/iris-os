import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("server-only", () => ({}));
import { runLocalA2AConformance } from "./conformance";

describe("A2A local conformance", () => {
  it("passes deterministic 0.3 and 1.0 profiles with wire evidence", async () => {
    const reports = await runLocalA2AConformance();
    expect(reports).toHaveLength(2);
    expect(reports.every((report) => report.passed)).toBe(true);
    expect(reports.map((report) => report.profile)).toEqual([
      "legacy-0.3-jsonrpc",
      "current-1.0-jsonrpc",
    ]);
  });
});
