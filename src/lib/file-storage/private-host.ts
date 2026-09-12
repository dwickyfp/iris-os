/**
 * Hostname rules mirroring the AI SDK's download validator: URLs pointing at
 * loopback / private networks cannot be fetched by the SDK and may also be
 * unreachable from user browsers (e.g. server-local MinIO).
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return true;
  }
  const segments = host.split(".");
  if (
    segments.length === 4 &&
    segments.every((segment) => /^\d+$/.test(segment))
  ) {
    const [a, b] = segments.map(Number);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    ) {
      return true;
    }
  }
  if (host === "::1") return true;
  return false;
}
