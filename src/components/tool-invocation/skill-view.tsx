"use client";

import { BookOpen, Check, ChevronDown, Loader2 } from "lucide-react";
import { Markdown } from "../markdown";

type SkillViewOutput = {
  alreadyLoaded?: boolean;
  skill?: { id?: string; name?: string; description?: string };
  content?: string;
  resources?: string[];
  filePath?: string;
  path?: string;
};

export function SkillView({
  output,
  loading,
}: {
  output?: unknown;
  loading?: boolean;
}) {
  const result = (output ?? {}) as SkillViewOutput;
  const title = result.filePath ?? result.path ?? result.skill?.name ?? "Skill";

  return (
    <details className="group rounded-lg border bg-secondary/20">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2.5 hover:bg-secondary/40">
        {loading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : result.alreadyLoaded ? (
          <Check className="size-4 text-muted-foreground" />
        ) : (
          <BookOpen className="size-4" />
        )}
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate text-sm font-medium">
            {loading ? "Loading skill" : `Skill loaded: ${title}`}
          </span>
          <span className="block text-xs text-muted-foreground">
            {result.alreadyLoaded
              ? "Instructions are already available in this request"
              : `${result.resources?.length ?? 0} supporting resources`}
          </span>
        </span>
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t px-4 py-3">
        {result.content ? (
          <Markdown>{result.content}</Markdown>
        ) : (
          <p className="text-sm text-muted-foreground">
            No additional content returned.
          </p>
        )}
        {!!result.resources?.length && (
          <div className="mt-3 border-t pt-3">
            <p className="mb-1 text-xs font-medium">Resources</p>
            <ul className="space-y-1 font-mono text-xs text-muted-foreground">
              {result.resources.map((resource) => (
                <li key={resource}>{resource}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}
