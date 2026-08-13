import { posix } from "node:path";

const SKILL_FILE_ROOTS = new Set([
  "references",
  "scripts",
  "assets",
  "templates",
]);

export function assertSafeSkillPath(path: string): string {
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    posix.isAbsolute(path)
  ) {
    throw new Error("Invalid skill file path");
  }

  const normalized = posix.normalize(path);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== path ||
    !SKILL_FILE_ROOTS.has(normalized.split("/")[0]) ||
    !normalized.includes("/")
  ) {
    throw new Error("Invalid skill file path");
  }
  return normalized;
}
