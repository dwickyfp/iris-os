import type { NodeHoverDrawingFunction } from "sigma/rendering";

export const MEMORY_GRAPH_HOVER_BACKGROUND = "#0f172a";
export const MEMORY_GRAPH_LABEL_COLOR = "#e2e8f0";

export const drawMemoryNodeHover: NodeHoverDrawingFunction = (
  context,
  data,
  settings,
) => {
  const size = settings.labelSize;
  const padding = 3;
  context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
  context.fillStyle = MEMORY_GRAPH_HOVER_BACKGROUND;
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;
  context.shadowBlur = 10;
  context.shadowColor = "rgba(0, 0, 0, 0.65)";

  if (typeof data.label === "string") {
    const boxWidth = Math.round(context.measureText(data.label).width + 8);
    const boxHeight = Math.round(size + 2 * padding);
    const radius = Math.max(data.size, size / 2) + padding;
    const angle = Math.asin(boxHeight / 2 / radius);
    const xDelta = Math.sqrt(
      Math.abs(radius ** 2 - (boxHeight / 2) ** 2),
    );
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
  context.fillStyle = MEMORY_GRAPH_LABEL_COLOR;
  if (data.label)
    context.fillText(data.label, data.x + data.size + 3, data.y + size / 3);
};
