import { UIMessage } from "ai";
import { serverFileStorage } from "lib/file-storage";
import {
  deriveStorageKeyFromUrl,
  guessObjectContentType,
} from "lib/file-storage/object-url";
import { isPrivateHostname } from "lib/file-storage/private-host";
import logger from "logger";

/**
 * The AI SDK's downloader rejects URLs pointing at localhost / private
 * networks (SSRF protection) with no allowlist option. Object storage that is
 * only reachable from the server (e.g. local MinIO, private buckets) is a
 * legitimate source for attachments, so those parts are inlined as data URLs
 * before model input is composed. data: URLs are treated as inline content by
 * the SDK and skip the network fetch entirely.
 */

async function fetchAsDataUrl(url: string): Promise<string | null> {
  // Preferred: the URL belongs to the active storage profile — download with
  // server credentials so private buckets work.
  try {
    const dataUrl = await serverFileStorage.withActive(
      async (storage, profile) => {
        const key = deriveStorageKeyFromUrl(new URL(url), profile);
        if (!key) return null;
        const [buffer, metadata] = await Promise.all([
          storage.download(key),
          storage.getMetadata(key).catch(() => null),
        ]);
        return `data:${guessObjectContentType(url, metadata?.contentType)};base64,${buffer.toString("base64")}`;
      },
    );
    if (dataUrl) return dataUrl;
  } catch (error) {
    logger.warn(
      `inline-blocked-file-urls: storage download for ${url} failed:`,
      error instanceof Error ? error.message : error,
    );
  }

  // Fallback: private URL that is not the active storage (plain server fetch).
  try {
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn(
        `inline-blocked-file-urls: fetch ${url} failed with ${response.status}`,
      );
      return null;
    }
    const contentType =
      response.headers.get("content-type") ?? "application/octet-stream";
    const buffer = Buffer.from(await response.arrayBuffer());
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  } catch (error) {
    logger.warn(
      `inline-blocked-file-urls: fetch ${url} failed:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function inlineBlockedFileUrls(
  messages: UIMessage[],
): Promise<UIMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      let changed = false;
      const parts = await Promise.all(
        message.parts.map(async (part: any) => {
          if (part?.type !== "file" || typeof part?.url !== "string") {
            return part;
          }
          let hostname: string;
          try {
            hostname = new URL(part.url).hostname;
          } catch {
            return part;
          }
          if (!isPrivateHostname(hostname)) return part;
          const dataUrl = await fetchAsDataUrl(part.url);
          if (!dataUrl) return part;
          changed = true;
          return { ...part, url: dataUrl };
        }),
      );
      return changed ? { ...message, parts } : message;
    }),
  );
}
