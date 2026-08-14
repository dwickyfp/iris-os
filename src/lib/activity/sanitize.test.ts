import { describe, expect, it } from "vitest";
import {
  ACTIVITY_PAYLOAD_MAX_BYTES,
  sanitizeActivityPayload,
} from "./sanitize";

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

  it("redacts credential-shaped values and reasoning fields", () => {
    expect(
      sanitizeActivityPayload({
        note: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        chainOfThought: "private reasoning",
      }),
    ).toEqual({
      note: "Authorization: [REDACTED]",
      chainOfThought: "[REDACTED]",
    });
  });

  it("caps the total serialized payload", () => {
    const result = sanitizeActivityPayload({
      values: Array.from(
        { length: 50 },
        (_, index) => `${index}-${"x".repeat(2_000)}`,
      ),
    });
    expect(
      Buffer.byteLength(JSON.stringify(result), "utf8"),
    ).toBeLessThanOrEqual(ACTIVITY_PAYLOAD_MAX_BYTES);
  });
});
