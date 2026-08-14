import { describe, expect, it } from "vitest";
import {
  defaultMemoryTopic,
  memoryContentHash,
  normalizeMemoryText,
} from "./curator";

describe("memory curator", () => {
  it("normalizes language, casing, and punctuation deterministically", () => {
    expect(normalizeMemoryText("  Aku SUKA ‘Jus Jambu’! ")).toBe(
      "aku suka jus jambu",
    );
    expect(memoryContentHash("Aku suka jus jambu")).toBe(
      memoryContentHash("aku SUKA jus jambu!"),
    );
  });

  it("gives equivalent text the same exact-content fingerprint", () => {
    expect(memoryContentHash("Aku suka jus jambu")).toBe(
      memoryContentHash("aku suka jus jambu."),
    );
  });

  it("uses kind-only fallback topics without interpreting content", () => {
    expect(defaultMemoryTopic("preference").key).toBe("preferences.general");
    expect(defaultMemoryTopic("goal").key).toBe("goals");
  });
});
