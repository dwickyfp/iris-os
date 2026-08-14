import { describe, expect, it } from "vitest";
import { automationRunKey } from "./idempotency";

describe("automationRunKey", () => {
  it("is stable per automation and scheduled instant", () => {
    const at = new Date("2026-08-14T01:00:00.000Z");
    expect(automationRunKey("automation-1", at)).toBe(
      automationRunKey("automation-1", at),
    );
    expect(automationRunKey("automation-2", at)).not.toBe(
      automationRunKey("automation-1", at),
    );
  });
});
