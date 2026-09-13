import { describe, expect, test } from "vitest";
import {
  dirnamePath,
  globToRegExp,
  matchesGlob,
  normalizeWorkspacePath,
} from "./path";

describe("normalizeWorkspacePath", () => {
  test("accepts a simple relative path", () => {
    expect(normalizeWorkspacePath("notes.md")).toEqual({
      ok: true,
      path: "notes.md",
    });
  });

  test("accepts nested paths and unicode", () => {
    expect(normalizeWorkspacePath("dokumen/laporan/q3.md")).toEqual({
      ok: true,
      path: "dokumen/laporan/q3.md",
    });
  });

  test("collapses duplicate slashes and single-dot segments", () => {
    expect(normalizeWorkspacePath("a//b/./c.txt")).toEqual({
      ok: true,
      path: "a/b/c.txt",
    });
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeWorkspacePath("  a/b.txt  ")).toEqual({
      ok: true,
      path: "a/b.txt",
    });
  });

  test.each([
    ["", "empty"],
    ["   ", "empty"],
    ["/etc/passwd", "absolute"],
    ["../escape", "parent"],
    ["a/../b", "parent"],
    ["a/..", "parent"],
    ["..", "parent"],
    ["a/.././../c", "parent"],
    ["a/", "trailing slash"],
    [".", "dot"],
    ["a\\\\b", "backslash"],
    ["a/\0b", "nul"],
    ["a/\nb", "control char"],
  ])("rejects %j", (input: string) => {
    const result = normalizeWorkspacePath(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  test("rejects paths longer than the limit", () => {
    const long = `${"a/".repeat(300)}file.txt`;
    expect(normalizeWorkspacePath(long).ok).toBe(false);
  });

  test("rejects paths deeper than the limit", () => {
    const deep = Array.from({ length: 20 }, (_, i) => `d${i}`).join("/");
    const result = normalizeWorkspacePath(deep);
    expect(result.ok).toBe(false);
  });

  test("respects custom limits", () => {
    expect(
      normalizeWorkspacePath("a/b/c", { maxPathLength: 4, maxPathDepth: 16 })
        .ok,
    ).toBe(false);
  });

  test("allows hidden dotfiles", () => {
    expect(normalizeWorkspacePath("config/.gitignore")).toEqual({
      ok: true,
      path: "config/.gitignore",
    });
  });
});

describe("dirnamePath", () => {
  test("returns parent for nested paths", () => {
    expect(dirnamePath("a/b/c.txt")).toBe("a/b");
    expect(dirnamePath("a/b/c")).toBe("a/b");
  });

  test("returns null for root-level paths", () => {
    expect(dirnamePath("notes.md")).toBeNull();
  });
});

describe("glob matching", () => {
  test("compiles a valid glob", () => {
    expect(globToRegExp("*.md")).toBeInstanceOf(RegExp);
  });

  test("rejects invalid globs", () => {
    expect(globToRegExp("")).toBeNull();
    expect(globToRegExp("/abs/*.md")).toBeNull();
    expect(globToRegExp("a/../b")).toBeNull();
  });

  test("single star does not cross directories", () => {
    expect(matchesGlob("*.md", "readme.md")).toBe(true);
    expect(matchesGlob("*.md", "docs/readme.md")).toBe(false);
  });

  test("double star crosses directories", () => {
    expect(matchesGlob("docs/**/*.md", "docs/readme.md")).toBe(true);
    expect(matchesGlob("docs/**/*.md", "docs/a/b/readme.md")).toBe(true);
    expect(matchesGlob("docs/**/*.md", "other/readme.md")).toBe(false);
  });

  test("question mark matches exactly one character", () => {
    expect(matchesGlob("file?.txt", "file1.txt")).toBe(true);
    expect(matchesGlob("file?.txt", "file10.txt")).toBe(false);
  });

  test("exact path matches without wildcards", () => {
    expect(matchesGlob("src/lib/a.ts", "src/lib/a.ts")).toBe(true);
    expect(matchesGlob("src/lib/a.ts", "src/lib/b.ts")).toBe(false);
  });

  test("regex special characters are escaped", () => {
    expect(matchesGlob("a+b.md", "a+b.md")).toBe(true);
    expect(matchesGlob("a+b.md", "aab.md")).toBe(false);
  });
});
