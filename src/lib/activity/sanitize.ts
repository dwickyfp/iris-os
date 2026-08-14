const sensitiveKey =
  /(?:password|secret|token|api[_-]?key|authorization|cookie)/i;

export function sanitizeActivityPayload(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (typeof value === "string") return value.slice(0, 2_000);
  if (typeof value === "number" || typeof value === "boolean" || value == null)
    return value;
  if (Array.isArray(value))
    return value
      .slice(0, 50)
      .map((item) => sanitizeActivityPayload(item, depth + 1));
  if (typeof value !== "object") return String(value).slice(0, 2_000);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, item]) => [
        key,
        sensitiveKey.test(key)
          ? "[REDACTED]"
          : sanitizeActivityPayload(item, depth + 1),
      ]),
  );
}
