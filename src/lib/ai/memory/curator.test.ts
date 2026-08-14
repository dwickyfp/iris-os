import { describe, expect, it } from "vitest";
import {
  classifyMemoryRelation,
  inferMemoryTopic,
  memoryContentHash,
  memorySubject,
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

  it("deduplicates repeated claims", () => {
    expect(
      classifyMemoryRelation("Aku suka jus jambu", "aku suka jus jambu."),
    ).toBe("duplicate");
  });

  it("keeps a refinement without treating it as a duplicate", () => {
    expect(
      classifyMemoryRelation(
        "Aku suka olahan sapi",
        "Aku sangat suka olahan sapi",
      ),
    ).toBe("refinement");
  });

  it("flags opposite polarity about the same subject as a conflict", () => {
    expect(
      classifyMemoryRelation(
        "Aku suka jus jambu",
        "Sekarang aku tidak suka jus jambu",
      ),
    ).toBe("conflict");
  });

  it("extracts a stable entity subject and topic", () => {
    expect(memorySubject("Aku sangat suka olahan sapi")).toBe("olahan sapi");
    expect(inferMemoryTopic("preference", "Aku suka jus jambu").key).toBe(
      "food-drink",
    );
  });
});
