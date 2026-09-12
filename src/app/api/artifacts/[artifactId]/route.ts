import { createHash } from "node:crypto";
import { getSession } from "auth/server";
import { artifactRepository } from "lib/db/repository";
import { serverFileStorage, withProfile } from "lib/file-storage";
import { NextResponse } from "next/server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ artifactId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { artifactId } = await params;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        artifactId,
      )
    ) {
      return NextResponse.json(
        { error: "Invalid artifact id" },
        { status: 400 },
      );
    }

    const artifact = await artifactRepository.selectById(artifactId);
    if (!artifact || artifact.userId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (artifact.status !== "active") {
      return NextResponse.json(
        { error: "Artifact is not available" },
        { status: 410 },
      );
    }

    const storage = artifact.storageProfileId
      ? withProfile(artifact.storageProfileId)
      : serverFileStorage;
    const bytes = await storage.download(artifact.storageKey);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== artifact.size || sha256 !== artifact.sha256) {
      return NextResponse.json(
        { error: "Artifact integrity check failed" },
        { status: 409 },
      );
    }

    const safeFilename = artifact.filename.replace(/[\r\n"\\]/g, "_");
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": artifact.mediaType,
        "Content-Length": String(artifact.size),
        "Content-Disposition": `attachment; filename="${safeFilename}"`,
        "Cache-Control": "private, no-store",
        "X-Artifact-SHA256": sha256,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to download artifact" },
      { status: 500 },
    );
  }
}
