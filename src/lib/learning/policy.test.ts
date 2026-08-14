import { describe, expect, test } from "vitest";
import {
  extractLearningSignal,
  isLearningAllowed,
  learningConfidence,
  learningSuppressionKey,
} from "./policy";

describe("learning policy", () => {
  test("requires repeated evidence for procedures and time patterns", () => {
    expect(
      extractLearningSignal({
        eventType: "chat.completed",
        payload: { userText: "Selalu lakukan langkah ini untuk release" },
      }),
    ).toMatchObject({ candidateType: "skill", threshold: 3 });
    expect(
      extractLearningSignal({
        eventType: "chat.completed",
        payload: { userText: "Setiap hari jalankan laporan" },
      }),
    ).toMatchObject({ candidateType: "automation", threshold: 3 });
  });

  test("uses exact scope in stable suppression keys", () => {
    const base = {
      userId: crypto.randomUUID(),
      scopeType: "workspace" as const,
      candidateType: "memory" as const,
      normalizedPattern: "use pnpm",
    };
    expect(
      learningSuppressionKey({ ...base, scopeId: crypto.randomUUID() }),
    ).not.toBe(
      learningSuppressionKey({ ...base, scopeId: crypto.randomUUID() }),
    );
  });

  test("bounds confidence and honors privacy settings", () => {
    expect(learningConfidence(100)).toBe(95);
    expect(
      learningConfidence({
        evidenceCount: 3,
        correctionCount: 2,
        ageDays: 30,
        consistency: 0.5,
      }),
    ).toBeLessThan(learningConfidence({ evidenceCount: 3 }));
    expect(
      isLearningAllowed({
        enabled: true,
        allowedScopes: ["workspace"],
        allowedCategories: ["skill"],
        scopeType: "global",
        candidateType: "skill",
      }),
    ).toBe(false);
  });
});
