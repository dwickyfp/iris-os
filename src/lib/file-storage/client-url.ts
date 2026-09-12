import { isPrivateHostname } from "./private-host";

/**
 * Rewrites URLs that user browsers cannot reach (server-local object storage
 * such as MinIO on localhost) into app-proxied URLs served by
 * /api/storage/file. Public URLs are returned unchanged.
 */
export function resolveServableFileUrl(
  url: string | undefined | null,
): string | undefined {
  if (!url) return url ?? undefined;
  if (
    url.startsWith("data:") ||
    url.startsWith("blob:") ||
    url.startsWith("/")
  ) {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return url;
    }
    if (!isPrivateHostname(parsed.hostname)) return url;
    return `/api/storage/file?url=${encodeURIComponent(url)}`;
  } catch {
    return url;
  }
}
