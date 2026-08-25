import { NextResponse } from "next/server";
import { parseCsvPreview, formatCsvPreviewText } from "lib/file-ingest/csv";
import { storageKeyFromUrl } from "lib/file-storage/storage-utils";
import { getSession } from "auth/server";
import { and, eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { UploadedFileTable } from "lib/db/pg/schema.pg";
import { withProfile } from "lib/file-storage";

type Body = {
  key?: string; // storage key (preferred)
  url?: string; // will be converted to key if possible
  type?: "csv" | "auto";
  maxRows?: number;
  maxCols?: number;
};

export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.user.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const key = body.key || (body.url ? storageKeyFromUrl(body.url) : undefined);
  if (!key) {
    return NextResponse.json(
      { error: "Missing 'key' or 'url'" },
      { status: 400 },
    );
  }

  // Infer type from extension when auto
  const type = body.type || "auto";
  const isCsv =
    type === "csv" ||
    /\.(csv)$/i.test(key) ||
    /(^|[?&])contentType=text\/csv(&|$)/i.test(body.url || "");

  if (!isCsv) {
    return NextResponse.json(
      {
        error: "Unsupported file type for ingest",
        solution:
          "Currently supported: CSV. Convert your spreadsheet to CSV or paste sample rows.",
      },
      { status: 400 },
    );
  }

  const [file] = await pgDb
    .select()
    .from(UploadedFileTable)
    .where(
      and(
        eq(UploadedFileTable.userId, session.user.id),
        eq(UploadedFileTable.storageKey, key),
      ),
    );
  if (!file)
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  const buf = await withProfile(file.storageProfileId).download(key);
  const preview = parseCsvPreview(buf, {
    maxRows: Math.min(200, Math.max(1, body.maxRows ?? 50)),
    maxCols: Math.min(40, Math.max(1, body.maxCols ?? 12)),
  });

  const text = formatCsvPreviewText(key, preview);

  return NextResponse.json({ ok: true, type: "csv", key, preview, text });
}
