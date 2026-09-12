"use client";

import { createDebounce } from "lib/utils";
import { Loader } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, useState } from "react";
import { sanitizeMermaidChart } from "@/lib/mermaid-sanitize";

let mermaidModule: typeof import("mermaid").default | null = null;

const loadMermaid = async () => {
  if (!mermaidModule) {
    mermaidModule = (await import("mermaid")).default;
  }
  return mermaidModule;
};

const readCssVar = (name: string, fallback: string) => {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
};

// Mermaid's theme color parser only understands rgb()/hex, so resolve any CSS
// color (oklch, hsl, var chains) through the browser into an rgb() string.
const resolveColor = (value: string): string | null => {
  if (typeof window === "undefined") return null;
  const el = document.createElement("div");
  el.style.color = value;
  el.style.display = "none";
  document.body.appendChild(el);
  const resolved = getComputedStyle(el).color;
  el.remove();
  return /^rgb\(/.test(resolved) ? resolved : null;
};

const parseRgb = (color: string): [number, number, number] | null => {
  const match = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

// Blend toward black (dark mode) or white (light mode) by percentage.
const mixColor = (color: string, pct: number, dark: boolean): string => {
  const rgb = parseRgb(color);
  if (!rgb) return color;
  const target: [number, number, number] = dark ? [0, 0, 0] : [255, 255, 255];
  const blended = rgb.map((channel, i) =>
    Math.round(channel * (pct / 100) + target[i] * (1 - pct / 100)),
  ) as [number, number, number];
  return `rgb(${blended.join(", ")})`;
};

// Build a mermaid theme from the app's design tokens so diagrams match the
// active light/dark palette instead of mermaid's grayscale defaults.
const buildThemeVariables = (dark: boolean) => {
  const mix = (cssVar: string, fallback: string, pct: number) => {
    const resolved =
      resolveColor(readCssVar(cssVar, fallback)) ??
      resolveColor(fallback) ??
      fallback;
    return mixColor(resolved, pct, dark);
  };

  const card = mix("--card", dark ? "#0a0a0b" : "#ffffff", 100);
  const foreground = mix("--foreground", dark ? "#fafafa" : "#09090b", 100);
  const border = mix("--border", dark ? "#27272a" : "#e4e4e7", 100);
  const mutedForeground = mix(
    "--muted-foreground",
    dark ? "#a1a1aa" : "#71717a",
    100,
  );

  return {
    darkMode: dark,
    background: "transparent",
    fontFamily:
      typeof window !== "undefined"
        ? getComputedStyle(document.body).fontFamily
        : undefined,
    fontSize: "15px",
    primaryColor: mix("--chart-1", "#3b82f6", dark ? 32 : 12),
    primaryTextColor: foreground,
    primaryBorderColor: mix("--chart-1", "#3b82f6", dark ? 75 : 50),
    secondaryColor: mix("--chart-2", "#60a5fa", dark ? 28 : 16),
    secondaryTextColor: foreground,
    secondaryBorderColor: mix("--chart-2", "#60a5fa", dark ? 70 : 50),
    tertiaryColor: mix("--chart-3", "#3b82f6", dark ? 26 : 20),
    tertiaryTextColor: foreground,
    tertiaryBorderColor: mix("--chart-3", "#3b82f6", dark ? 70 : 50),
    lineColor: mix("--chart-1", "#3b82f6", dark ? 58 : 45),
    textColor: foreground,
    edgeLabelBackground: card,
    clusterBkg: mix("--chart-1", "#3b82f6", dark ? 12 : 6),
    clusterBorder: border,
    arrowheadColor: mutedForeground,
  };
};

interface MermaidDiagramProps {
  chart?: string;
}

export function MermaidDiagram({ chart }: MermaidDiagramProps) {
  const { theme } = useTheme();
  const [state, setState] = useState<{
    svg: string;
    error: string | null;
    loading: boolean;
  }>({
    svg: "",
    error: null,
    loading: true,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const previousChartRef = useRef<string>(chart);
  const debounce = useMemo(() => createDebounce(), []);

  useEffect(() => {
    // Reset states if chart has changed
    if (previousChartRef.current !== chart) {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      previousChartRef.current = chart;
    }

    // Debounce rendering to avoid flickering during streaming
    debounce(async () => {
      if (!chart?.trim()) {
        setState({ svg: "", error: null, loading: false });
        return;
      }

      try {
        const mermaid = await loadMermaid();

        // Initialize mermaid with a theme derived from the app's design tokens
        const dark = theme === "dark";
        mermaid.initialize({
          startOnLoad: false,
          theme: "base",
          darkMode: dark,
          securityLevel: "loose",
          themeVariables: buildThemeVariables(dark),
          flowchart: {
            curve: "basis",
            padding: 14,
            nodeSpacing: 55,
            rankSpacing: 65,
            useMaxWidth: true,
          },
        });

        // // First try to parse to catch syntax errors early
        const sanitized = sanitizeMermaidChart(chart);
        await mermaid.parse(sanitized);

        // Render the diagram
        const id = `mermaid-${Date.now()}`;
        const { svg } = await mermaid.render(id, sanitized);

        setState({ svg, error: null, loading: false });
      } catch (err) {
        console.error("Mermaid rendering error:", err);
        setState({
          svg: "",
          error:
            err instanceof Error ? err.message : "Failed to render diagram",
          loading: false,
        });
      }
    }, 500);

    return () => {
      debounce.clear();
    };
  }, [chart, theme, debounce]);

  if (state.loading) {
    return (
      <div className="flex items-center justify-center h-20 w-full">
        <div className="text-muted-foreground flex items-center gap-2">
          Rendering diagram <Loader className="size-4 animate-spin" />
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="pb-4 overflow-auto">
        <div className="text-destructive p-4">
          <p>Error rendering Mermaid diagram:</p>
          <pre className="mt-2 p-2 bg-destructive/10 dark:bg-destructive/20 rounded text-xs overflow-auto">
            {state.error}
          </pre>
          <pre className="mt-2 p-2 bg-accent/10 dark:bg-accent/20 rounded text-xs overflow-auto">
            {chart}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex justify-center overflow-auto transition-opacity duration-200 [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  );
}
