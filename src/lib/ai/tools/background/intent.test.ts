import { describe, expect, it } from "vitest";
import {
  hasExplicitAutomationIntent,
  hasExplicitLearningControlIntent,
} from "./intent";

describe("background control intent", () => {
  it("requires explicit learning control language", () => {
    expect(hasExplicitLearningControlIntent("Matikan learning untuk task ini")).toBe(true);
    expect(hasExplicitLearningControlIntent("Apa yang sudah kamu pelajari?")).toBe(false);
  });

  it("accepts explicit scheduling language and rejects unrelated prompts", () => {
    expect(hasExplicitAutomationIntent("Jadwalkan laporan ini setiap hari")).toBe(true);
    expect(hasExplicitAutomationIntent("Buat ringkasan laporan hari ini")).toBe(false);
  });
});
