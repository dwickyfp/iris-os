import { randomUUID } from "node:crypto";
import { requireAdminActor } from "auth/permissions";
import { pgStorageProfileRepository } from "lib/db/pg/repositories/storage-profile-repository.pg";
import { createProfileStorage } from "lib/file-storage/storage-router";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdminActor();
  } catch {
    return Response.json(
      { error: "Forbidden" },
      { status: 403, headers: NO_STORE },
    );
  }
  const profile = await pgStorageProfileRepository.getById((await params).id);
  if (!profile)
    return Response.json(
      { error: "Profile not found" },
      { status: 404, headers: NO_STORE },
    );
  const storage = createProfileStorage(profile);
  const key = `iris-health/${randomUUID()}.txt`;
  try {
    await storage.upload(Buffer.from("iris-storage-ok"), {
      key,
      filename: "probe.txt",
      contentType: "text/plain",
    });
    const metadata = await storage.getMetadata(key);
    const bytes = await storage.download(key);
    if (!metadata || bytes.toString("utf8") !== "iris-storage-ok")
      throw new Error("Storage verification failed");
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch {
    return Response.json(
      { error: "Storage connection test failed" },
      { status: 400, headers: NO_STORE },
    );
  } finally {
    await storage.delete(key).catch(() => undefined);
  }
}
