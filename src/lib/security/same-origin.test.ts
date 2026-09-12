import { describe, expect, test } from "vitest";
import { MUTATING_METHODS, isAllowedOrigin } from "./same-origin";

describe("isAllowedOrigin", () => {
  test("allows requests without an Origin header (non-browser)", () => {
    expect(isAllowedOrigin(null, "app.example.test")).toBe(true);
  });

  test("allows same-origin requests", () => {
    expect(
      isAllowedOrigin("https://app.example.test", "app.example.test"),
    ).toBe(true);
  });

  test("rejects cross-origin browser requests", () => {
    expect(isAllowedOrigin("https://evil.example", "app.example.test")).toBe(
      false,
    );
    expect(
      isAllowedOrigin("https://app.example.test:8443", "app.example.test"),
    ).toBe(false);
  });

  test("rejects when the host header is missing", () => {
    expect(isAllowedOrigin("https://app.example.test", null)).toBe(false);
  });

  test("rejects malformed origin headers", () => {
    expect(isAllowedOrigin("not a url", "app.example.test")).toBe(false);
  });

  test("mutating methods cover the dangerous set", () => {
    expect([...MUTATING_METHODS].sort()).toEqual([
      "DELETE",
      "PATCH",
      "POST",
      "PUT",
    ]);
  });
});
