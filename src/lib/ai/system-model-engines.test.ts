import { describe, expect, test } from "vitest";
import {
  SYSTEM_MODEL_ENGINES,
  getSystemModelEngine,
  isSystemEngineModelCompatible,
  resolveSystemEngineModels,
} from "./system-model-engines";

const chatModel = {
  modelKind: "chat" as const,
  capabilities: {
    toolCalls: true,
    structuredOutput: true,
    vision: false,
  },
};

describe("system model engine registry", () => {
  test("registers every configurable internal engine", () => {
    expect(SYSTEM_MODEL_ENGINES.map((engine) => engine.key)).toEqual([
      "memory-curator",
      "automation-runner",
      "delegation-runner",
      "context-summary",
      "thread-title",
      "memory-embedding",
    ]);
  });

  test("enforces model kind and required capabilities", () => {
    const curator = getSystemModelEngine("memory-curator");
    expect(isSystemEngineModelCompatible(curator, chatModel)).toBe(true);
    expect(
      isSystemEngineModelCompatible(curator, {
        ...chatModel,
        capabilities: { ...chatModel.capabilities, toolCalls: false },
      }),
    ).toBe(false);
    expect(
      isSystemEngineModelCompatible(
        getSystemModelEngine("memory-embedding"),
        chatModel,
      ),
    ).toBe(false);
  });

  test("uses an assignment when valid and otherwise falls back to default", () => {
    const engine = getSystemModelEngine("automation-runner");
    const models = [
      {
        ...chatModel,
        id: "default",
        enabled: true,
        providerEnabled: true,
        isDefault: true,
      },
      {
        ...chatModel,
        id: "assigned",
        enabled: true,
        providerEnabled: true,
        isDefault: false,
      },
    ];
    expect(
      resolveSystemEngineModels(engine, models, "assigned").effective?.id,
    ).toBe("assigned");
    models[1].enabled = false;
    const fallback = resolveSystemEngineModels(engine, models, "assigned");
    expect(fallback.assignedIsUsable).toBe(false);
    expect(fallback.effective?.id).toBe("default");
  });

  test("returns no effective model when no compatible fallback exists", () => {
    const resolved = resolveSystemEngineModels(
      getSystemModelEngine("memory-embedding"),
      [
        {
          ...chatModel,
          id: "chat",
          enabled: true,
          providerEnabled: true,
          isDefault: true,
        },
      ],
      null,
    );
    expect(resolved.effective).toBeNull();
  });
});
