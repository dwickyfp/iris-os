import type { FileStorageProfile } from "./storage-profile";

/**
 * Maps an object storage URL back to its key using the active profile config,
 * so server-side code (proxy route, model-input inlining) can fetch objects
 * with server credentials regardless of whether the origin is publicly
 * reachable.
 */
export function deriveStorageKeyFromUrl(
  target: URL,
  profile: FileStorageProfile,
): string | null {
  const s3 = profile.s3;
  if (!s3) return null;

  const targetPath = target.pathname.replace(/\/+$/, "");
  const decodeKeyFromPath = (path: string) =>
    path
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment))
      .join("/");

  if (s3.publicBaseUrl) {
    try {
      const base = new URL(s3.publicBaseUrl);
      const basePrefix = base.pathname.replace(/\/+$/, "");
      if (
        target.host === base.host &&
        (targetPath === basePrefix ||
          targetPath.startsWith(`${basePrefix}/`))
      ) {
        return decodeKeyFromPath(targetPath.slice(basePrefix.length));
      }
    } catch {
      // malformed publicBaseUrl — fall through
    }
  }

  if (s3.endpoint) {
    try {
      const endpoint = new URL(s3.endpoint);
      const hostMatches = target.host === endpoint.host;
      const virtualHostMatches =
        Boolean(s3.bucket) &&
        target.host.startsWith(`${s3.bucket}.${endpoint.host}`);
      if (hostMatches || virtualHostMatches) {
        // Path-style: /<bucket>/<key>
        if (s3.bucket && targetPath.startsWith(`/${s3.bucket}/`)) {
          return decodeKeyFromPath(targetPath.slice(s3.bucket.length + 1));
        }
        // Virtual-host style: <bucket>.<endpoint host>
        if (virtualHostMatches && targetPath) {
          return decodeKeyFromPath(targetPath);
        }
      }
    } catch {
      // malformed endpoint — fall through
    }
  }

  return null;
}

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  txt: "text/plain",
};

export function guessObjectContentType(
  pathname: string,
  storedContentType?: string | null,
): string {
  if (storedContentType) return storedContentType;
  const extension = pathname.match(/\.(\w+)$/)?.[1]?.toLowerCase();
  return (extension && EXTENSION_CONTENT_TYPES[extension]) ||
    "application/octet-stream";
}
