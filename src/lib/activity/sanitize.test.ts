import { describe, expect, it } from "vitest";
import { sanitizeActivityPayload } from "./sanitize";

describe("sanitizeActivityPayload", () => {
  it("redacts secret-like keys recursively and bounds strings", () => {
    expect(
      sanitizeActivityPayload({
        apiKey: "secret",
        nested: { password: "secret", ok: "x".repeat(3_000) },
      }),
    ).toEqual({
      apiKey: "[REDACTED]",
      nested: { password: "[REDACTED]", ok: "x".repeat(2_000) },
    });
  });
});
