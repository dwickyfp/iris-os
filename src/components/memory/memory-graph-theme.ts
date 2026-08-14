export type MemoryNodeColorRole =
  | "scope"
  | "topic"
  | "claim"
  | "entity"
  | "superseded";

export type MemoryEdgeColorRole = "conflict" | "related" | "default" | "scope";

export interface MemoryGraphPalette {
  scope: string;
  topic: string;
  claim: string;
  entity: string;
  superseded: string;
  conflict: string;
  related: string;
  edge: string;
  scopeEdge: string;
  label: string;
  hoverBackground: string;
  hoverLabel: string;
  hoverShadow: string;
  dimmed: string;
}

export const MEMORY_GRAPH_THEME_TOKENS = {
  scope: "--foreground",
  topic: "--chart-1",
  claim: "--chart-2",
  entity: "--chart-3",
  superseded: "--muted-foreground",
  conflict: "--destructive",
  related: "--chart-4",
  edge: "--muted-foreground",
  scopeEdge: "--border",
  label: "--foreground",
  hoverBackground: "--popover",
  hoverLabel: "--popover-foreground",
  hoverShadow: "--foreground",
  dimmed: "--muted-foreground",
} as const;

export function createMemoryGraphPalette(
  resolve: (token: string) => string,
): MemoryGraphPalette {
  return Object.fromEntries(
    Object.entries(MEMORY_GRAPH_THEME_TOKENS).map(([role, token]) => [
      role,
      resolve(token),
    ]),
  ) as unknown as MemoryGraphPalette;
}

export function readMemoryGraphPalette(
  element: HTMLElement,
): MemoryGraphPalette {
  const styles = getComputedStyle(element);
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Unable to resolve Memory Graph theme colors");

  return createMemoryGraphPalette((token) => {
    const value = styles.getPropertyValue(token).trim();
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
    return `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
  });
}

export function withColorAlpha(color: string, opacity: number): string {
  const channels = color.match(
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/,
  );
  if (!channels) return color;
  const alpha = channels[4] === undefined ? 1 : Number(channels[4]);
  return `rgba(${channels[1]}, ${channels[2]}, ${channels[3]}, ${Math.max(
    0,
    Math.min(1, alpha * opacity),
  )})`;
}

export function nodeColor(
  palette: MemoryGraphPalette,
  role: MemoryNodeColorRole,
): string {
  return palette[role];
}

export function edgeColor(
  palette: MemoryGraphPalette,
  role: MemoryEdgeColorRole,
): string {
  if (role === "default") return palette.edge;
  if (role === "scope") return palette.scopeEdge;
  return palette[role];
}
