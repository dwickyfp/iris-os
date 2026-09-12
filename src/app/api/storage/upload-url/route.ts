import { getSession } from "auth/server";
import { colorize } from "consola/utils";
import { storageDriver } from "lib/file-storage";
import globalLogger from "lib/logger";
import { NextResponse } from "next/server";
import { checkStorageAction } from "../actions";

const logger = globalLogger.withDefaults({
  message: colorize("blackBright", `[${storageDriver} Upload URL API]`),
});

const FALLBACK_UPLOAD_URL = "/api/storage/upload";

interface FallbackResponse {
  directUploadSupported: false;
  fallbackUrl: string;
  message: string;
}

// Helpers
function createFallbackResponse(): FallbackResponse {
  return {
    directUploadSupported: false,
    fallbackUrl: FALLBACK_UPLOAD_URL,
    message: "Use multipart/form-data upload to fallbackUrl",
  };
}

/**
 * Upload URL endpoint.
 *
 * Provides optimal upload method based on storage backend:
 * - Vercel Blob: Client token for direct upload
 * - S3: Presigned URL (future)
 * - Local FS: Fallback to server upload
 */
export async function POST(_request: Request) {
  // Authenticate
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check storage configuration first
  const storageCheck = await checkStorageAction();
  if (!storageCheck.isValid) {
    logger.error("Storage configuration error", {
      error: storageCheck.error,
      solution: storageCheck.solution,
    });

    return NextResponse.json(
      {
        error: storageCheck.error,
        solution: storageCheck.solution,
        storageDriver,
      },
      { status: 500 },
    );
  }

  return NextResponse.json(createFallbackResponse());
}
