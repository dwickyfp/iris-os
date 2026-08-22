import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import tar, { type Headers } from "tar-stream";

export type ArchiveLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  workspacePrefix?: boolean;
};

const MAX_PATH_BYTES = 4_096;
const MAX_NAME_BYTES = 255;
const MAX_HEADER_METADATA_BYTES = 8_192;

function safeName(value: string): string {
  if (
    !value ||
    Buffer.byteLength(value) > MAX_PATH_BYTES ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value)
  ) {
    throw new Error("Archive contains an unsafe or oversized path");
  }
  const normalized = path.posix.normalize(value).replace(/^\.\//, "");
  if (
    !normalized ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error("Archive path escapes workspace");
  }
  if (
    normalized
      .split("/")
      .some((part) => Buffer.byteLength(part) > MAX_NAME_BYTES)
  ) {
    throw new Error("Archive path name exceeded metadata limit");
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

function metadataBytes(header: Headers): number {
  let bytes = 0;
  const visit = (value: unknown) => {
    if (typeof value === "string") bytes += Buffer.byteLength(value);
    else if (value && typeof value === "object" && !(value instanceof Date)) {
      for (const [key, nested] of Object.entries(value)) {
        bytes += Buffer.byteLength(key);
        visit(nested);
      }
    }
  };
  visit(header);
  return bytes;
}

function validateHeader(header: Headers, limits: ArchiveLimits): Headers {
  if (metadataBytes(header) > MAX_HEADER_METADATA_BYTES) {
    throw new Error("Archive header metadata exceeded limit");
  }
  const name = safeName(
    archiveName(header.name, limits.workspacePrefix ?? false),
  );
  const type = header.type ?? "file";
  if (type !== "file" && type !== "directory") {
    throw new Error("Archive links and special files are forbidden");
  }
  const size = header.size ?? 0;
  if (
    !Number.isSafeInteger(size) ||
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

export async function validateAndRepackArchive(
  input: NodeJS.ReadableStream,
  limits: ArchiveLimits,
): Promise<Buffer> {
  const extract = tar.extract();
  const pack = tar.pack();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  let entries = 0;
  let totalBytes = 0;
  let packedBytes = 0;
  let failed = false;

  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    const cause = error instanceof Error ? error : new Error(String(error));
    if ("destroy" in input && typeof input.destroy === "function") {
      input.destroy();
    }
    extract.destroy();
    pack.destroy();
    output.destroy(cause);
  };

  output.on("data", (value) => {
    packedBytes += value.length;
    if (packedBytes > limits.maxTotalBytes) {
      fail(new Error("Packed archive exceeded size limit"));
      return;
    }
    chunks.push(Buffer.from(value));
  });
  pack.pipe(output);

  extract.on("entry", (rawHeader, stream, next) => {
    let header: Headers;
    try {
      header = validateHeader(rawHeader, limits);
      entries += 1;
      if (entries > limits.maxFiles) {
        throw new Error("Archive has too many entries");
      }
    } catch (error) {
      stream.resume();
      fail(error);
      return;
    }

    let entryBytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        entryBytes += chunk.length;
        totalBytes += chunk.length;
        if (entryBytes > limits.maxFileBytes) {
          callback(new Error("Archive entry exceeded size limit"));
        } else if (totalBytes > limits.maxTotalBytes) {
          callback(new Error("Archive exceeded total size limit"));
        } else {
          callback(undefined, chunk);
        }
      },
    });
    const destination = pack.entry(header);
    void pipeline(stream, limiter, destination)
      .then(() => {
        if (entryBytes !== header.size) {
          throw new Error("Archive entry size mismatch");
        }
        next();
      })
      .catch(fail);
  });

  const extracted = new Promise<void>((resolve, reject) => {
    extract.once("finish", resolve);
    extract.once("error", reject);
    input.once("error", reject);
  });
  const packed = new Promise<void>((resolve, reject) => {
    output.once("end", resolve);
    output.once("error", reject);
    pack.once("error", reject);
  });

  input.pipe(extract);
  try {
    await Promise.race([extracted, packed]);
    pack.finalize();
    await packed;
    return Buffer.concat(chunks);
  } catch (error) {
    fail(error);
    throw error;
  }
}
