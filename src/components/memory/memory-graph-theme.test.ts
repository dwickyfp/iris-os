import { describe, expect, it } from "vitest";
import {
  MEMORY_GRAPH_THEME_TOKENS,
  createMemoryGraphPalette,
  withColorAlpha,
} from "./memory-graph-theme";

describe("memory graph theme", () => {
  it("maps every visual role to a design-system token", () => {
    const palette = createMemoryGraphPalette((token) => `resolved:${token}`);

    for (const [role, token] of Object.entries(MEMORY_GRAPH_THEME_TOKENS)) {
      expect(palette[role as keyof typeof palette]).toBe(`resolved:${token}`);
    }
    expect(Object.values(MEMORY_GRAPH_THEME_TOKENS)).not.toContain(
      "--slate-950",
    );
  });

  it("multiplies resolved color alpha for depth rendering", () => {
    expect(withColorAlpha("rgba(10, 20, 30, 0.8)", 0.5)).toBe(
      "rgba(10, 20, 30, 0.4)",
    );
    expect(withColorAlpha("rgb(10, 20, 30)", 0.25)).toBe(
      "rgba(10, 20, 30, 0.25)",
    );
  });
});
