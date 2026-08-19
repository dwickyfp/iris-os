import { describe, expect, it } from "vitest";
import { sealEvidence, stableJson, verifyEvidence } from "./evidence";

describe("migration evidence", () => {
  it("is stable across object key order and detects changes", () => {
    expect(stableJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      stableJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
    const sealed = sealEvidence({
      evidenceVersion: 1,
      operation: "integrity",
      passed: true,
    });
    expect(verifyEvidence(sealed.json, sealed.hash).passed).toBe(true);
    expect(() =>
      verifyEvidence(sealed.json.replace("true", "false"), sealed.hash),
    ).toThrow(/hash mismatch/);
  });
});
