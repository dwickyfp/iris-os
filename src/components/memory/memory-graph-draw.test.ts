import { describe, expect, it } from "vitest";
import { createMemoryNodeHover } from "./memory-graph-draw";
import type { MemoryGraphPalette } from "./memory-graph-theme";

const palette: MemoryGraphPalette = {
  scope: "rgba(1, 1, 1, 1)",
  topic: "rgba(2, 2, 2, 1)",
  claim: "rgba(3, 3, 3, 1)",
  entity: "rgba(4, 4, 4, 1)",
  superseded: "rgba(5, 5, 5, 1)",
  conflict: "rgba(6, 6, 6, 1)",
  related: "rgba(7, 7, 7, 1)",
  edge: "rgba(8, 8, 8, 1)",
  scopeEdge: "rgba(9, 9, 9, 1)",
  label: "rgba(10, 10, 10, 1)",
  hoverBackground: "rgba(11, 11, 11, 1)",
  hoverLabel: "rgba(12, 12, 12, 1)",
  hoverShadow: "rgba(13, 13, 13, 1)",
  dimmed: "rgba(14, 14, 14, 1)",
};

describe("memory graph hover drawing", () => {
  it("uses contrasting background and label colors", () => {
    const fills: string[] = [];
    const labels: Array<{ color: string; text: string }> = [];
    let fillStyle = "";
    const context = {
      beginPath() {},
      moveTo() {},
      lineTo() {},
      arc() {},
      closePath() {},
      fill() {
        fills.push(fillStyle);
      },
      fillText(text: string) {
        labels.push({ color: fillStyle, text });
      },
      measureText() {
        return { width: 80 };
      },
      set fillStyle(value: string) {
        fillStyle = value;
      },
      get fillStyle() {
        return fillStyle;
      },
      font: "",
      shadowBlur: 0,
      shadowColor: "",
      shadowOffsetX: 0,
      shadowOffsetY: 0,
    } as unknown as CanvasRenderingContext2D;

    createMemoryNodeHover(palette)(
      context,
      { color: "#f8fafc", label: "Global Memory", size: 17, x: 50, y: 50 },
      {
        labelColor: { color: palette.label },
        labelFont: "Arial",
        labelSize: 13,
        labelWeight: "500",
      } as never,
    );

    expect(fills).toEqual([palette.hoverBackground]);
    expect(labels).toEqual([
      { color: palette.hoverLabel, text: "Global Memory" },
    ]);
    expect(palette.hoverBackground).not.toBe(palette.hoverLabel);
  });
});
