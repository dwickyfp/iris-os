export type ExecOutput = { stdout: Buffer; stderr: Buffer };

export async function decodeDockerMultiplexedStream(
  input: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<ExecOutput> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const header = Buffer.alloc(8);
  let headerBytes = 0;
  let frameBytes = 0;
  let frameStream = 0;
  let total = 0;

  for await (const value of input) {
    const chunk = Buffer.from(value);
    let offset = 0;
    while (offset < chunk.length) {
      if (frameBytes === 0) {
        const copied = chunk.copy(
          header,
          headerBytes,
          offset,
          offset + Math.min(8 - headerBytes, chunk.length - offset),
        );
        headerBytes += copied;
        offset += copied;
        if (headerBytes < 8) continue;

        frameStream = header[0];
        if (
          (frameStream !== 1 && frameStream !== 2) ||
          header[1] !== 0 ||
          header[2] !== 0 ||
          header[3] !== 0
        ) {
          throw new Error("Invalid Docker multiplex stream");
        }
        frameBytes = header.readUInt32BE(4);
        headerBytes = 0;
        if (frameBytes > maxBytes || total + frameBytes > maxBytes) {
          throw new Error("Exec output exceeded limit");
        }
        if (frameBytes === 0) continue;
      }

      const length = Math.min(frameBytes, chunk.length - offset);
      const payload = chunk.subarray(offset, offset + length);
      (frameStream === 1 ? stdout : stderr).push(Buffer.from(payload));
      total += length;
      frameBytes -= length;
      offset += length;
    }
  }
  if (headerBytes !== 0 || frameBytes !== 0) {
    throw new Error("Truncated Docker multiplex stream");
  }
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}
