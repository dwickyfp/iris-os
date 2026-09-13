import type { WorkspaceFsLimits } from "./limits";
import { WORKSPACE_FS_LIMITS } from "./limits";

export type PathValidationResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

type PathLimits = Pick<WorkspaceFsLimits, "maxPathLength" | "maxPathDepth">;

/**
 * Validate and normalize a workspace-relative path. Paths are jailed to a
 * single scope root: relative POSIX-style segments only, no traversal, no
 * separators other than "/", no control characters. Returns the normalized
 * path without a leading slash.
 */
export function normalizeWorkspacePath(
  input: string,
  limits: PathLimits = WORKSPACE_FS_LIMITS,
): PathValidationResult {
  if (typeof input !== "string")
    return { ok: false, error: "Path must be a string." };
  const trimmed = input.trim();
  if (trimmed.length === 0)
    return { ok: false, error: "Path must not be empty." };
  if (trimmed.startsWith("/"))
    return { ok: false, error: "Path must be relative to the workspace root." };
  if (trimmed.endsWith("/"))
    return { ok: false, error: "Path must name a file, not a directory." };
  if (trimmed.length > limits.maxPathLength)
    return {
      ok: false,
      error: `Path exceeds ${limits.maxPathLength} characters.`,
    };

  const segments: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..")
      return {
        ok: false,
        error: "Path must not contain parent directory segments.",
      };
    if (segment.includes("\\"))
      return {
        ok: false,
        error: "Path segments must not contain backslashes.",
      };
    if (/[\u0000-\u001f\u007f]/.test(segment))
      return {
        ok: false,
        error: "Path segments must not contain control characters.",
      };
    segments.push(segment);
  }
  if (segments.length === 0)
    return { ok: false, error: "Path must name a file." };
  if (segments.length > limits.maxPathDepth)
    return {
      ok: false,
      error: `Path exceeds ${limits.maxPathDepth} segments.`,
    };
  return { ok: true, path: segments.join("/") };
}

/** Parent directory of a normalized path, or null for root-level files. */
export function dirnamePath(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index === -1 ? null : path.slice(0, index);
}

/**
 * Compile a workspace glob into a RegExp. `*` matches within one segment,
 * `**` as a full segment crosses directories, `?` matches one character.
 * Returns null for invalid patterns (empty, absolute, traversal).
 */
export function globToRegExp(pattern: string): RegExp | null {
  if (typeof pattern !== "string" || pattern.length === 0) return null;
  const normalized = normalizeWorkspacePath(pattern);
  if (!normalized.ok) return null;

  let source = "^";
  const segments = normalized.path.split("/");
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    const last = i === segments.length - 1;
    if (segment === "**") {
      source += last ? "(?:[^/]+(?:/[^/]+)*)" : "(?:[^/]+/)*";
      continue;
    }
    let part = "";
    for (const char of segment) {
      if (char === "*") part += "[^/]*";
      else if (char === "?") part += "[^/]";
      else part += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    source += part;
    if (!last) source += "/";
  }
  source += "$";
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

export function matchesGlob(pattern: string, target: string): boolean {
  const regexp = globToRegExp(pattern);
  return regexp !== null && regexp.test(target);
}

const MEDIA_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  css: "text/css",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  ts: "text/typescript",
  tsx: "text/typescript",
  js: "text/javascript",
  jsx: "text/javascript",
  py: "text/x-python",
  sh: "text/x-shellscript",
  sql: "text/x-sql",
};

/** Best-effort media type from a path extension; text by default. */
export function mediaTypeForPath(path: string): string {
  const filename = path.split("/").pop() ?? path;
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return "text/plain";
  const extension = filename.slice(dot + 1).toLowerCase();
  return MEDIA_TYPES[extension] ?? "text/plain";
}
