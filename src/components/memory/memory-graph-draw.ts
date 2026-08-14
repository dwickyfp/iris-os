import type { NodeHoverDrawingFunction } from "sigma/rendering";
import type { MemoryGraphPalette } from "./memory-graph-theme";
import { withColorAlpha } from "./memory-graph-theme";

export const createMemoryNodeHover =
  (palette: MemoryGraphPalette): NodeHoverDrawingFunction =>
  (context, data, settings) => {
    const size = settings.labelSize;
    const padding = 3;
    context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
    context.fillStyle = palette.hoverBackground;
    context.shadowOffsetX = 0;
    context.shadowOffsetY = 0;
    context.shadowBlur = 10;
    context.shadowColor = withColorAlpha(palette.hoverShadow, 0.45);

    if (typeof data.label === "string") {
      const boxWidth = Math.round(context.measureText(data.label).width + 8);
      const boxHeight = Math.round(size + 2 * padding);
      const radius = Math.max(data.size, size / 2) + padding;
      const angle = Math.asin(boxHeight / 2 / radius);
      const xDelta = Math.sqrt(Math.abs(radius ** 2 - (boxHeight / 2) ** 2));
      context.beginPath();
      context.moveTo(data.x + xDelta, data.y + boxHeight / 2);
      context.lineTo(data.x + radius + boxWidth, data.y + boxHeight / 2);
      context.lineTo(data.x + radius + boxWidth, data.y - boxHeight / 2);
      context.lineTo(data.x + xDelta, data.y - boxHeight / 2);
      context.arc(data.x, data.y, radius, angle, -angle);
      context.closePath();
      context.fill();
    } else {
      context.beginPath();
      context.arc(data.x, data.y, data.size + padding, 0, Math.PI * 2);
      context.closePath();
      context.fill();
    }

    context.shadowBlur = 0;
    context.fillStyle = palette.hoverLabel;
    if (data.label)
      context.fillText(data.label, data.x + data.size + 3, data.y + size / 3);
  };
