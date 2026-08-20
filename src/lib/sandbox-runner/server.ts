import { createHash, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { DockerApiError } from "./docker";
import {
  CapacityError,
  ExecTimeoutError,
  NotFoundError,
  ReadinessError,
  SandboxRunner,
  ValidationError,
} from "./runner";

const createSessionSchema = z.object({
  profile: z.object({
    id: z.string().trim().min(1).max(128),
    network: z.enum(["none", "egress"]),
  }),
  limits: z.object({
    cpuMillis: z.number().int().positive(),
    memoryMb: z.number().int().positive(),
    tmpfsMb: z.number().int().positive(),
    pidsLimit: z.number().int().positive().optional(),
    executionTimeoutMs: z.number().int().min(100),
    idleTimeoutMs: z.number().int().min(1_000),
    absoluteTimeoutMs: z.number().int().min(1_000),
  }),
});

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(token));
}

function json(response: ServerResponse, status: number, body: unknown) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

async function readJson(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > maxBytes)
      throw new ValidationError("Request body exceeded limit");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("Invalid JSON body");
  }
}

export function createSandboxRunnerServer(runner: SandboxRunner) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://sandbox-runner.invalid");
      if (request.method === "GET" && url.pathname === "/live") {
        json(response, 200, { status: "ok" });
        return;
      }
      if (
        !authorized(
          request.headers.authorization,
          runner.config.SANDBOX_RUNNER_TOKEN,
        )
      ) {
        response.setHeader("WWW-Authenticate", "Bearer");
        json(response, 401, { error: "UNAUTHORIZED" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/ready") {
        json(
          response,
          runner.readiness ? 200 : 503,
          runner.readiness
            ? { ready: true }
            : { ready: false, reason: "RUNSC_UNAVAILABLE" },
        );
        return;
      }
      if (!runner.readiness) throw new ReadinessError("runsc is unavailable");

      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        const parsed = createSessionSchema.safeParse(
          await readJson(request, 64 * 1024),
        );
        if (!parsed.success) {
          throw new ValidationError("Invalid session profile or limits");
        }
        const session = await runner.createSession(parsed.data);
        json(response, 201, {
          id: session.id,
          profile: session.profile,
          limits: session.limits,
          createdAt: new Date(session.createdAt).toISOString(),
          expiresAt: new Date(
            Math.min(
              session.lastUsedAt + session.limits.idleTimeoutMs,
              session.createdAt + session.limits.absoluteTimeoutMs,
            ),
          ).toISOString(),
        });
        return;
      }
      const match = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)(?:\/(files|exec))?$/,
      );
      if (!match) throw new NotFoundError("Route not found");
      const id = match[1];
      const action = match[2];
      if (request.method === "GET" && !action) {
        json(response, 200, await runner.getSession(id));
        return;
      }
      if (request.method === "DELETE" && !action) {
        await runner.deleteSession(id);
        response.writeHead(204).end();
        return;
      }
      if (request.method === "PUT" && action === "files") {
        if (request.headers["content-type"] !== "application/x-tar") {
          throw new ValidationError("Content-Type must be application/x-tar");
        }
        await runner.putFiles(id, request);
        response.writeHead(204).end();
        return;
      }
      if (request.method === "GET" && action === "files") {
        const archive = await runner.getFiles(
          id,
          url.searchParams.get("path") ?? ".",
        );
        response.writeHead(200, {
          "Content-Type": "application/x-tar",
          "Content-Length": archive.length,
          "Cache-Control": "no-store",
        });
        response.end(archive);
        return;
      }
      if (request.method === "POST" && action === "exec") {
        const body = (await readJson(request, 256 * 1024)) as {
          cmd?: unknown;
          timeoutMs?: unknown;
        };
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.once("aborted", abort);
        response.once("close", () => {
          if (!response.writableFinished) abort();
        });
        const timeoutMs =
          typeof body.timeoutMs === "number" ? body.timeoutMs : undefined;
        const result = await runner.exec(
          id,
          body?.cmd,
          controller.signal,
          timeoutMs,
        );
        json(response, 200, result);
        return;
      }
      throw new NotFoundError("Route not found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error as Error);
        return;
      }
      if (
        error instanceof NotFoundError ||
        (error instanceof DockerApiError && error.statusCode === 404)
      ) {
        json(response, 404, { error: "NOT_FOUND" });
      } else if (
        error instanceof ValidationError ||
        error instanceof SyntaxError
      ) {
        json(response, 400, {
          error: "INVALID_REQUEST",
          message: error.message,
        });
      } else if (error instanceof ReadinessError) {
        json(response, 503, { error: "RUNSC_UNAVAILABLE" });
      } else if (error instanceof CapacityError) {
        json(response, 429, { error: "SESSION_CAPACITY_EXCEEDED" });
      } else if (error instanceof ExecTimeoutError) {
        json(response, 408, { error: "EXEC_TIMEOUT" });
      } else {
        console.error("sandbox runner request failed", error);
        json(response, 502, { error: "SANDBOX_FAILURE" });
      }
    }
  });
}
