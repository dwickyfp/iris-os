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
});
