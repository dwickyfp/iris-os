import path from "node:path";

export function safeSandboxRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    throw new Error("SANDBOX_ARTIFACT_PATH_INVALID");
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== value
  ) {
    throw new Error("SANDBOX_ARTIFACT_PATH_INVALID");
  }
  return normalized;
}
