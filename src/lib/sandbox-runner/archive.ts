import path from "node:path";
import { PassThrough } from "node:stream";
import tar, { type Headers } from "tar-stream";

export type ArchiveLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  workspacePrefix?: boolean;
};

type ArchiveEntry = { header: Headers; body: Buffer };

function safeName(value: string): string {
  if (
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value)
  ) {
    throw new Error("Archive contains an unsafe path");
  }
  const normalized = path.posix.normalize(value).replace(/^\.\//, "");
  if (!normalized || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Archive path escapes workspace");
  }
  return normalized;
}

function archiveName(value: string, workspacePrefix: boolean): string {
  if (workspacePrefix && value.startsWith("/workspace/")) {
    return value.slice("/workspace/".length);
  }
  if (workspacePrefix && value === "/workspace") return ".";
  return value;
}

function validateHeader(header: Headers, limits: ArchiveLimits): Headers {
  const name = safeName(
    archiveName(header.name, limits.workspacePrefix ?? false),
  );
  const type = header.type ?? "file";
  if (type !== "file" && type !== "directory") {
    throw new Error("Archive links and special files are forbidden");
  }
  const size = header.size ?? 0;
  if (
    size < 0 ||
    size > limits.maxFileBytes ||
    (type === "directory" && size !== 0)
  ) {
    throw new Error("Archive entry exceeded size limit");
  }
  return {
    name,
    type,
    size,
    mode: type === "directory" ? 0o700 : 0o600,
    uid: 10001,
    gid: 10001,
    mtime: new Date(0),
  };
}

async function parseArchive(
  input: NodeJS.ReadableStream,
  limits: ArchiveLimits,
) {
  const extract = tar.extract();
  const entries: ArchiveEntry[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => {
      if ("destroy" in input && typeof input.destroy === "function")
        input.destroy();
      extract.destroy();
      reject(error);
    };
    extract.on("entry", (rawHeader, stream, next) => {
      try {
        const header = validateHeader(rawHeader, limits);
        if (++total > limits.maxFiles)
          throw new Error("Archive has too many entries");
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (value) => {
          size += value.length;
          if (size > limits.maxFileBytes) {
            stream.destroy();
            fail(new Error("Archive entry exceeded size limit"));
          } else chunks.push(Buffer.from(value));
        });
        stream.once("error", fail);
        stream.once("end", () => {
          if (size !== (header.size ?? 0)) {
            fail(new Error("Archive entry size mismatch"));
            return;
          }
          entries.push({ header, body: Buffer.concat(chunks) });
          next();
        });
        stream.resume();
      } catch (error) {
        stream.resume();
        fail(error);
      }
    });
    extract.once("finish", resolve);
    extract.once("error", reject);
    input.once("error", fail);
    input.pipe(extract);
  });
  const bytes = entries.reduce((sum, entry) => sum + entry.body.length, 0);
  if (bytes > limits.maxTotalBytes)
    throw new Error("Archive exceeded total size limit");
  return entries;
}

async function packArchive(
  entries: ArchiveEntry[],
  limits: ArchiveLimits,
): Promise<Buffer> {
  const pack = tar.pack();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  let size = 0;
  output.on("data", (value) => {
    size += value.length;
    if (size > limits.maxTotalBytes)
      output.destroy(new Error("Packed archive exceeded size limit"));
    else chunks.push(Buffer.from(value));
  });
  pack.pipe(output);
  const done = new Promise<void>((resolve, reject) => {
    output.once("end", resolve);
    output.once("error", reject);
    pack.once("error", reject);
  });
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      pack.entry(entry.header, entry.body, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }
  pack.finalize();
  await done;
  return Buffer.concat(chunks);
}

export async function validateAndRepackArchive(
  input: NodeJS.ReadableStream,
  limits: ArchiveLimits,
): Promise<Buffer> {
  return packArchive(await parseArchive(input, limits), limits);
}
