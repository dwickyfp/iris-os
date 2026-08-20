export type ExecOutput = { stdout: Buffer; stderr: Buffer };

export async function decodeDockerMultiplexedStream(
  input: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<ExecOutput> {
  let pending = Buffer.alloc(0);
  let total = 0;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  for await (const value of input) {
    pending = Buffer.concat([pending, Buffer.from(value)]);
    while (pending.length >= 8) {
      const stream = pending[0];
      const length = pending.readUInt32BE(4);
      if (length > maxBytes || total + length > maxBytes)
        throw new Error("Exec output exceeded limit");
      if (pending.length < 8 + length) break;
      const payload = pending.subarray(8, 8 + length);
      if (stream === 1) stdout.push(payload);
      else if (stream === 2) stderr.push(payload);
      else throw new Error("Invalid Docker multiplex stream");
      total += length;
      pending = pending.subarray(8 + length);
    }
    if (pending.length > maxBytes + 8)
      throw new Error("Exec frame exceeded limit");
  }
  if (pending.length !== 0)
    throw new Error("Truncated Docker multiplex stream");
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}
