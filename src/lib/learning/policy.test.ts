import { describe, expect, test } from "vitest";
import {
  canAutoPromoteSkill,
  extractLearningSignal,
  isLearningAllowed,
  learningConfidence,
  learningSuppressionKey,
  isChatCorrection,
  procedureSimilarity,
} from "./policy";

describe("learning policy", () => {
  test("requires repeated evidence for procedures and rejects inferred automation", () => {
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
    ).toBeNull();
    expect(
      extractLearningSignal({
        eventType: "chat.completed",
        payload: { userText: "Ingat bahwa aku suka laporan ringkas" },
      }),
    ).toBeNull();
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

  test("auto-promotes only safe skills with three successful outcomes", () => {
    const base = {
      enabled: true,
      autonomyLevel: 1,
      allowedCategories: ["memory", "skill"] as const,
      correctionCount: 0,
    };
    expect(
      canAutoPromoteSkill({
        ...base,
        allowedCategories: [...base.allowedCategories],
        evidenceCount: 3,
        successfulOutcomeCount: 3,
      }),
    ).toBe(true);
    expect(
      canAutoPromoteSkill({
        ...base,
        allowedCategories: [...base.allowedCategories],
        evidenceCount: 3,
        successfulOutcomeCount: 3,
        correctionCount: 1,
      }),
    ).toBe(false);
    expect(
      canAutoPromoteSkill({
        ...base,
        allowedCategories: [...base.allowedCategories],
        evidenceCount: 2,
        successfulOutcomeCount: 2,
      }),
    ).toBe(false);
  });

  test("detects explicit corrections without matching ordinary prompts", () => {
    expect(isChatCorrection("Koreksi prosedur release sebelumnya")).toBe(true);
    expect(isChatCorrection("Tolong buat prosedur release")).toBe(false);
    expect(
      procedureSimilarity(
        "Koreksi prosedur release: jangan lakukan deploy tanpa test",
        "Selalu lakukan test sebelum deploy saat release",
      ),
    ).toBeGreaterThanOrEqual(0.45);
    expect(
      procedureSimilarity("ubah prosedur release", "buat laporan keuangan"),
    ).toBe(0);
  });
});
