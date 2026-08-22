import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { decodeDockerMultiplexedStream } from "./exec";

function frame(stream: number, value: string) {
  const body = Buffer.from(value);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

describe("Docker exec multiplex decoder", () => {
  it("decodes frames split across arbitrary chunks", async () => {
    const encoded = Buffer.concat([frame(1, "out"), frame(2, "err")]);
    const result = await decodeDockerMultiplexedStream(
      Readable.from([
        encoded.subarray(0, 3),
        encoded.subarray(3, 12),
        encoded.subarray(12),
      ]),
      16,
    );
    expect(result.stdout.toString()).toBe("out");
    expect(result.stderr.toString()).toBe("err");
  });

  it("rejects oversized, invalid, and truncated streams", async () => {
    await expect(
      decodeDockerMultiplexedStream(Readable.from(frame(1, "12345")), 4),
    ).rejects.toThrow("limit");
    await expect(
      decodeDockerMultiplexedStream(Readable.from(frame(3, "x")), 4),
    ).rejects.toThrow("Invalid");
    await expect(
      decodeDockerMultiplexedStream(
        Readable.from(frame(1, "x").subarray(0, 8)),
        4,
      ),
    ).rejects.toThrow("Truncated");
  });

  it("rejects nonzero reserved header bytes and source stream errors", async () => {
    const malformed = frame(1, "x");
    malformed[1] = 1;
    await expect(
      decodeDockerMultiplexedStream(Readable.from(malformed), 4),
    ).rejects.toThrow("Invalid");

    const source = new Readable({
      read() {
        this.destroy(new Error("socket failed"));
      },
    });
    await expect(decodeDockerMultiplexedStream(source, 4)).rejects.toThrow(
      "socket failed",
    );
  });
});
