import { describe, expect, it } from "vitest";
import {
  drawMemoryNodeHover,
  MEMORY_GRAPH_HOVER_BACKGROUND,
  MEMORY_GRAPH_LABEL_COLOR,
} from "./memory-graph-draw";

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

    drawMemoryNodeHover(
      context,
      { color: "#f8fafc", label: "Global Memory", size: 17, x: 50, y: 50 },
      {
        labelColor: { color: MEMORY_GRAPH_LABEL_COLOR },
        labelFont: "Arial",
        labelSize: 13,
        labelWeight: "500",
      } as never,
    );

    expect(fills).toEqual([MEMORY_GRAPH_HOVER_BACKGROUND]);
    expect(labels).toEqual([
      { color: MEMORY_GRAPH_LABEL_COLOR, text: "Global Memory" },
    ]);
    expect(MEMORY_GRAPH_HOVER_BACKGROUND).not.toBe(MEMORY_GRAPH_LABEL_COLOR);
  });
});
