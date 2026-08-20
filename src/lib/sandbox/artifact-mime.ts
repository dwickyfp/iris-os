import path from "node:path";

const MIME_EXTENSIONS: Record<string, readonly string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "application/pdf": [".pdf"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
    ".xlsx",
  ],
  "application/json": [".json"],
  "text/csv": [".csv"],
  "text/plain": [".txt", ".text", ".log", ".md"],
};

function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  return Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
}

export function detectSandboxArtifactMime(
  bytes: Buffer,
  filename: string,
): string {
  let mediaType: string | undefined;
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    mediaType = "image/png";
  } else if (
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    mediaType = "image/jpeg";
  } else if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    mediaType = "application/pdf";
  } else if (
    bytes.subarray(0, 4).equals(Buffer.from("504b0304", "hex")) &&
    bytes.includes(Buffer.from("[Content_Types].xml")) &&
    bytes.includes(Buffer.from("xl/"))
  ) {
    mediaType =
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  } else if (isUtf8Text(bytes)) {
    const text = bytes.toString("utf8");
    try {
      JSON.parse(text);
      mediaType = "application/json";
    } catch {
      if (path.extname(filename).toLowerCase() === ".csv") {
        const rows = text.trim().split(/\r?\n/);
        if (!rows.length || rows.some((row) => !row.includes(","))) {
          throw new Error("SANDBOX_ARTIFACT_MIME_EXTENSION_MISMATCH");
        }
        mediaType = "text/csv";
      } else {
        mediaType = "text/plain";
      }
    }
  }

  const extension = path.extname(filename).toLowerCase();
  if (!mediaType || !MIME_EXTENSIONS[mediaType]?.includes(extension)) {
    throw new Error("SANDBOX_ARTIFACT_MIME_EXTENSION_MISMATCH");
  }
  return mediaType;
}
