import { PassThrough, Readable } from "node:stream";
import tar, { type Headers } from "tar-stream";
import { describe, expect, it } from "vitest";
import { validateAndRepackArchive } from "./archive";

const limits = { maxFiles: 3, maxFileBytes: 16, maxTotalBytes: 4_096 };

async function archive(header: Headers, body = Buffer.alloc(0)) {
  const pack = tar.pack();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  pack.pipe(output);
  pack.entry(header, body);
  pack.finalize();
  await new Promise<void>((resolve, reject) => {
    output.once("end", resolve);
    output.once("error", reject);
  });
  return Buffer.concat(chunks);
}

describe("sandbox archives", () => {
  it("parses and repacks regular files with fixed ownership and modes", async () => {
    const result = await validateAndRepackArchive(
      Readable.from(
        await archive({ name: "src/main.js", size: 2 }, Buffer.from("ok")),
      ),
      limits,
    );
    const extract = tar.extract();
    const entry = new Promise<{ header: Headers; body: string }>((resolve) => {
      extract.on("entry", (header, stream, next) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on("end", () => {
          resolve({ header, body: Buffer.concat(chunks).toString() });
          next();
        });
      });
    });
    extract.end(result);
    await expect(entry).resolves.toMatchObject({
      body: "ok",
      header: {
        name: "src/main.js",
        type: "file",
        uid: 10001,
        gid: 10001,
        mode: 0o600,
      },
    });
  });

  it.each([
    [{ name: "../secret", type: "file" }, "path"],
    [{ name: "/etc/passwd", type: "file" }, "path"],
    [{ name: "hard", type: "link", linkname: "target" }, "special"],
    [{ name: "link", type: "symlink", linkname: "../secret" }, "special"],
    [{ name: "device", type: "character-device" }, "special"],
  ] as const)("rejects unsafe archive entry %#", async (header, message) => {
    await expect(
      validateAndRepackArchive(Readable.from(await archive(header)), limits),
    ).rejects.toThrow(message);
  });

  it("rejects per-file, count, and repacked archive limits", async () => {
    await expect(
      validateAndRepackArchive(
        Readable.from(
          await archive({ name: "large", size: 17 }, Buffer.alloc(17)),
        ),
        limits,
      ),
    ).rejects.toThrow("size limit");

    const pack = tar.pack();
    for (let index = 0; index < 4; index++) {
      pack.entry({ name: String(index) }, Buffer.from("x"));
    }
    pack.finalize();
    await expect(validateAndRepackArchive(pack, limits)).rejects.toThrow(
      "too many",
    );
  });

  it("rejects aggregate bytes before consuming the complete source", async () => {
    const pack = tar.pack();
    pack.entry({ name: "one" }, Buffer.alloc(12));
    pack.entry({ name: "two" }, Buffer.alloc(12));
    pack.finalize();
    const encoded = Buffer.concat(await Array.fromAsync(pack));
    let consumed = 0;
    const source = Readable.from(
      (async function* () {
        for (let offset = 0; offset < encoded.length; offset += 64) {
          consumed = Math.min(offset + 64, encoded.length);
          yield encoded.subarray(offset, consumed);
          await new Promise((resolve) => setImmediate(resolve));
        }
      })(),
    );

    await expect(
      validateAndRepackArchive(source, {
        maxFiles: 3,
        maxFileBytes: 16,
        maxTotalBytes: 20,
      }),
    ).rejects.toThrow("limit");
    expect(consumed).toBeLessThan(encoded.length);
  });

  it("rejects bounded path components and oversized header metadata", async () => {
    await expect(
      validateAndRepackArchive(
        Readable.from(await archive({ name: "a".repeat(256) })),
        limits,
      ),
    ).rejects.toThrow("metadata limit");

    await expect(
      validateAndRepackArchive(
        Readable.from(
          await archive({
            name: "safe",
            pax: { comment: "x".repeat(8_192) },
          } as Headers),
        ),
        limits,
      ),
    ).rejects.toThrow("metadata");
  });

  it("rejects malformed and truncated tar input", async () => {
    await expect(
      validateAndRepackArchive(Readable.from(Buffer.alloc(512, 0xff)), limits),
    ).rejects.toThrow();

    const encoded = await archive(
      { name: "partial", size: 16 },
      Buffer.alloc(16),
    );
    await expect(
      validateAndRepackArchive(Readable.from(encoded.subarray(0, 520)), limits),
    ).rejects.toThrow();
  });
});
