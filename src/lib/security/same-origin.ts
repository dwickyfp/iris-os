/**
 * Same-origin enforcement for state-changing API requests. Session cookies
 * are SameSite=Lax, but an explicit Origin check removes the reliance on
 * cookie defaults alone. Non-browser clients (no Origin header) pass; a
 * cross-origin browser request is rejected with 403.
 */
export function isAllowedOrigin(
  originHeader: string | null,
  requestHost: string | null,
): boolean {
  if (!originHeader) return true;
  try {
    const origin = new URL(originHeader);
    if (!requestHost) return false;
    const host = requestHost.split(",")[0].trim();
    return origin.host === host;
  } catch {
    return false;
  }
}

export const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
