import http, { type IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";

const MAX_DOCKER_RESPONSE = 8 * 1024 * 1024;

export class DockerApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(`Docker API ${statusCode}: ${message}`);
  }
}

export type DockerStreamResponse = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  stream: Readable;
};

export class DockerClient {
  constructor(readonly socketPath: string) {}

  async request<T = unknown>(
    method: string,
    path: string,
    body?: Buffer | object,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.stream(method, path, body, signal);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of response.stream) {
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > MAX_DOCKER_RESPONSE) {
        response.stream.destroy();
        throw new Error("Docker response exceeded limit");
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new DockerApiError(response.statusCode, raw.slice(0, 1_024));
    }
    const contentType = response.headers["content-type"] ?? "";
    if (contentType.includes("application/json") && raw)
      return JSON.parse(raw) as T;
    return raw as T;
  }

  stream(
    method: string,
    path: string,
    body?: Buffer | object,
    signal?: AbortSignal,
  ): Promise<DockerStreamResponse> {
    const payload =
      body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.socketPath,
          method,
          path,
          signal,
          headers: payload
            ? {
                "Content-Length": payload.length,
                "Content-Type": Buffer.isBuffer(body)
                  ? "application/x-tar"
                  : "application/json",
              }
            : undefined,
        },
        (response) =>
          resolve({
            statusCode: response.statusCode ?? 500,
            headers: response.headers,
            stream: response,
          }),
      );
      request.once("error", reject);
      if (payload) request.end(payload);
      else request.end();
    });
  }
}

export function dockerPath(segment: string): string {
  return encodeURIComponent(segment).replaceAll("%2F", "%2F");
}
