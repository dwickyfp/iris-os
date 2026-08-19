import { describe, expect, test } from "vitest";
import { ExecutionDriverRegistry } from "./registry";

describe("ExecutionDriverRegistry", () => {
  test("keeps execution runtime selection separate from peer delegation", () => {
    const native = { id: "ai-sdk" } as never;
    const registry = new ExecutionDriverRegistry([native]);
    expect(registry.get("ai-sdk")).toBe(native);
    expect(registry.has("codex")).toBe(false);
    expect(() => registry.get("codex")).toThrow(
      "Execution driver not found: codex",
    );
  });

  test("rejects ambiguous duplicate driver ids", () => {
    const registry = new ExecutionDriverRegistry([{ id: "ai-sdk" } as never]);
    expect(() => registry.register({ id: "ai-sdk" } as never)).toThrow(
      "Execution driver already registered: ai-sdk",
    );
  });
});
