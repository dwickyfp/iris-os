const sensitiveKey =
  /(?:password|secret|token|api[_-]?key|authorization|cookie|chain[_-]?of[_-]?thought|reasoning)/i;
const sensitiveValue =
  /(?:bearer\s+[a-z0-9._~+/=-]{12,}|\bsk-[a-z0-9_-]{12,}|(?:api[_-]?key|token|password)\s*[:=]\s*[^\s,;]+)/gi;

export const ACTIVITY_PAYLOAD_MAX_BYTES = 32 * 1024;

function sanitize(value: unknown, depth: number): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (typeof value === "string")
    return value.slice(0, 2_000).replace(sensitiveValue, "[REDACTED]");
  if (typeof value === "number" || typeof value === "boolean" || value == null)
    return value;
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (typeof value !== "object") return String(value).slice(0, 2_000);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? "[REDACTED]" : sanitize(item, depth + 1),
      ]),
  );
}

export function sanitizeActivityPayload(value: unknown) {
  const sanitized = sanitize(value, 0);
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized, "utf8") <= ACTIVITY_PAYLOAD_MAX_BYTES)
    return sanitized;
  return {
    truncated: true,
    preview: serialized.slice(0, ACTIVITY_PAYLOAD_MAX_BYTES - 256),
  };
}
