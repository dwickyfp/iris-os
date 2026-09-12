import { getSession } from "auth/server";
import { serverFileStorage } from "lib/file-storage";
import {
  deriveStorageKeyFromUrl,
  guessObjectContentType,
} from "lib/file-storage/object-url";
import { NextResponse } from "next/server";

/**
 * Streams stored objects through the app so browsers never need direct access
 * to the object storage origin (which may be private or server-local, e.g.
 * MinIO on localhost).
 *
 * GET /api/storage/file?url=<encoded source url>
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sourceUrl = new URL(request.url).searchParams.get("url");
  if (!sourceUrl) {
    return NextResponse.json(
      { error: "Missing 'url' query parameter" },
      { status: 400 },
    );
  }

  let target: URL;
  try {
    target = new URL(sourceUrl);
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return NextResponse.json(
      { error: "Unsupported protocol" },
      { status: 400 },
    );
  }

  try {
    return await serverFileStorage.withActive(async (storage, profile) => {
      const key = deriveStorageKeyFromUrl(target, profile);
      if (!key) {
        return NextResponse.json(
          { error: "URL does not belong to the active storage" },
          { status: 400 },
        );
      }
      const [buffer, metadata] = await Promise.all([
        storage.download(key),
        storage.getMetadata(key).catch(() => null),
      ]);
      return new Response(new Uint8Array(buffer), {
        headers: {
          "Content-Type": guessObjectContentType(
            target.pathname,
            metadata?.contentType,
          ),
          "Content-Length": String(buffer.length),
          "Cache-Control": "private, max-age=86400, immutable",
        },
      });
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to fetch object",
      },
      { status: 500 },
    );
  }
}
