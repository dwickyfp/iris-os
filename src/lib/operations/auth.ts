import { createHash, timingSafeEqual } from "node:crypto";

export function hasValidMetricsBearer(
  authorization: string | null,
  expectedToken: string,
): boolean {
  const prefix = "Bearer ";
  const supplied = authorization?.startsWith(prefix)
    ? authorization.slice(prefix.length)
    : "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(supplied), digest(expectedToken));
}
