"use client";

import { useCopy } from "@/hooks/use-copy";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { cn } from "lib/utils";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useTheme } from "next-themes";
import dynamic from "next/dynamic";
import type { JSX } from "react";
import { Fragment, useLayoutEffect, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import {
  type BundledLanguage,
  bundledLanguages,
  codeToHast,
} from "shiki/bundle/web";
import { safe } from "ts-safe";
import { Button } from "ui/button";
import JsonView from "ui/json-view";

// Dynamically import MermaidDiagram component
const MermaidDiagram = dynamic(
  () => import("./mermaid-diagram").then((mod) => mod.MermaidDiagram),
  {
    loading: () => (
      <div className="h-20 w-full flex items-center justify-center">
        <span className="text-muted-foreground">
          Loading Mermaid renderer...
        </span>
      </div>
    ),
    ssr: false,
  },
);

// Mermaid blocks get a single card: a header like other code blocks, on top
// of the dotted-grid diagram canvas (no outer pre card around it).
const MermaidPre = ({ code }: { code: string }) => {
  const { copied, copy } = useCopy();

  return (
    <div className="text-sm flex flex-col relative my-4 overflow-hidden border rounded-2xl shadow bg-card">
      <div className="p-1.5 border-b z-20 bg-secondary">
        <div className="w-full flex z-20 py-0.5 px-4 items-center">
          <span className="text-sm text-muted-foreground">mermaid</span>
          <Button
            size="icon"
            variant={copied ? "secondary" : "ghost"}
            className="ml-auto z-10 p-3! size-2! rounded-sm"
            onClick={() => {
              copy(code);
            }}
          >
            {copied ? <CheckIcon /> : <CopyIcon className="size-3!" />}
          </Button>
        </div>
      </div>
      <div className="relative p-4 bg-card/50 [background-image:radial-gradient(circle,var(--border)_1px,transparent_1px)] [background-size:22px_22px]">
        <MermaidDiagram chart={code} />
      </div>
    </div>
  );
};

const PurePre = ({
  children,
  className,
  code,
  lang,
}: {
  children: any;
  className?: string;
  code: string;
  lang: string;
}) => {
  const { copied, copy } = useCopy();

  return (
    <pre className={cn("relative", className)}>
      <div className="p-1.5 border-b mb-4 z-20 bg-secondary">
        <div className="w-full flex z-20 py-0.5 px-4 items-center">
          <span className="text-sm text-muted-foreground">{lang}</span>
          <Button
            size="icon"
            variant={copied ? "secondary" : "ghost"}
            className="ml-auto z-10 p-3! size-2! rounded-sm"
            onClick={() => {
              copy(code);
            }}
          >
            {copied ? <CheckIcon /> : <CopyIcon className="size-3!" />}
          </Button>
        </div>
      </div>

      <div className="relative overflow-x-auto px-6 pb-6">{children}</div>
    </pre>
  );
};

export async function Highlight(
  code: string,
  lang: BundledLanguage | (string & {}),
  theme: string,
) {
  const parsed: BundledLanguage = (
    bundledLanguages[lang] ? lang : "md"
  ) as BundledLanguage;

  if (lang === "json") {
    return (
      <PurePre code={code} lang={lang}>
        <JsonView data={code} initialExpandDepth={3} />
      </PurePre>
    );
  }

  if (lang === "mermaid") {
    return <MermaidPre code={code} />;
  }

  const out = await codeToHast(code, {
    lang: parsed,
    theme,
  });

  return toJsxRuntime(out, {
    Fragment,
    jsx,
    jsxs,
    components: {
      pre: (props) => <PurePre {...props} code={code} lang={lang} />,
    },
  }) as JSX.Element;
}

export function PreBlock({ children }: { children: any }) {
  const code = children.props.children;
  const { theme } = useTheme();
  const language = children.props.className?.split("-")?.[1] || "bash";
  const [loading, setLoading] = useState(true);
  const isMermaid = language === "mermaid";
  const [component, setComponent] = useState<JSX.Element | null>(
    <PurePre className="animate-pulse" code={code} lang={language}>
      {children}
    </PurePre>,
  );

  useLayoutEffect(() => {
    safe()
      .map(() =>
        Highlight(
          code,
          language,
          theme == "dark" ? "dark-plus" : "github-light",
        ),
      )
      .ifOk(setComponent)
      .watch(() => setLoading(false));
  }, [theme, language, code]);

  // For other code blocks, render as before
  return (
    <div
      className={cn(
        loading && !isMermaid && "animate-pulse",
        isMermaid
          ? "text-sm relative"
          : "text-sm flex bg-secondary/40 shadow border flex-col rounded relative my-4 overflow-hidden",
      )}
    >
      {isMermaid ? <MermaidPre code={code} /> : component}
    </div>
  );
}
