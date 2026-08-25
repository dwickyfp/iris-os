import { NextResponse } from "next/server";
import { getSession } from "auth/server";
import { serverFileStorage, storageDriver } from "lib/file-storage";
import { checkStorageAction } from "../actions";
import { pgDb } from "lib/db/pg/db.pg";
import { UploadedFileTable } from "lib/db/pg/schema.pg";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export async function POST(request: Request) {
  const session = await getSession();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check storage configuration first
  const storageCheck = await checkStorageAction();
  if (!storageCheck.isValid) {
    return NextResponse.json(
      {
        error: storageCheck.error,
        solution: storageCheck.solution,
        storageDriver,
      },
      { status: 500 },
    );
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return NextResponse.json(
        { error: "No file provided. Use 'file' field in FormData." },
        { status: 400 },
      );
    }
    if (file.size > MAX_UPLOAD_BYTES)
      return NextResponse.json({ error: "File exceeds 50 MiB limit" }, { status: 413 });

    // Read file content
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Upload to storage (works with any storage backend)
    const result = await serverFileStorage.upload(buffer, {
      filename: file.name,
      contentType: file.type || "application/octet-stream",
    });
    if (!result.storageProfileId)
      throw new Error("STORAGE_PROFILE_REQUIRED");
    let uploaded: { id: string };
    try {
      [uploaded] = await pgDb
        .insert(UploadedFileTable)
        .values({
          userId: session.user.id,
          storageProfileId: result.storageProfileId,
          storageKey: result.key,
          sourceUrl: result.sourceUrl,
          filename: result.metadata.filename,
          mediaType: result.metadata.contentType,
          size: result.metadata.size,
        })
        .returning({ id: UploadedFileTable.id });
    } catch (error) {
      await serverFileStorage
        .withProfile(result.storageProfileId)
        .delete(result.key)
        .catch(() => undefined);
      throw error;
    }

    return NextResponse.json({
      success: true,
      key: result.key,
      url: result.sourceUrl,
      metadata: result.metadata,
      storageProfileId: result.storageProfileId,
      fileId: uploaded.id,
    });
  } catch (error) {
    console.error("Failed to upload file", error);
    return NextResponse.json(
      { error: "Failed to upload file" },
      { status: 500 },
    );
  }
}
