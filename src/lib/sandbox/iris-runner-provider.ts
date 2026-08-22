import { PassThrough } from "node:stream";
import tar from "tar-stream";
import type {
  PythonComputeRequest,
  PythonComputeResult,
  SandboxInstance,
  SandboxProfile,
  SandboxProvider,
  SandboxProviderStatus,
  SandboxRunnerInventory,
  SandboxRunnerSessionCreateRequest,
  SandboxRunnerSessionResponse,
  SandboxScope,
} from "./contracts";

export interface IrisRunnerHttpClient {
  request<T>(input: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    body?: unknown;
    signal?: AbortSignal;
  }): Promise<T>;
  uploadArchive(
    path: string,
    archive: Buffer,
    signal?: AbortSignal,
  ): Promise<void>;
  downloadArchive(path: string, signal?: AbortSignal): Promise<Buffer>;
}

export class FetchIrisRunnerHttpClient implements IrisRunnerHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async request<T>(input: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    body?: unknown;
    signal?: AbortSignal;
  }): Promise<T> {
    const response = await this.fetcher(new URL(input.path, this.baseUrl), {
      method: input.method,
      headers: {
        accept: "application/json",
        ...(input.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: input.signal,
    });
    if (!response.ok) throw new Error(`IRIS_RUNNER_HTTP_${response.status}`);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  async uploadArchive(path: string, archive: Buffer, signal?: AbortSignal) {
    const response = await this.fetcher(new URL(path, this.baseUrl), {
      method: "PUT",
      headers: {
        "content-type": "application/x-tar",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: new Uint8Array(archive),
      signal,
    });
    if (!response.ok) throw new Error(`IRIS_RUNNER_HTTP_${response.status}`);
  }

  async downloadArchive(path: string, signal?: AbortSignal) {
    const response = await this.fetcher(new URL(path, this.baseUrl), {
      headers: {
        accept: "application/x-tar",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      signal,
    });
    if (!response.ok) throw new Error(`IRIS_RUNNER_HTTP_${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
}

async function packFiles(files: NonNullable<PythonComputeRequest["files"]>) {
  const pack = tar.pack();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  pack.pipe(output);
  const finished = new Promise<void>((resolve, reject) => {
    output.once("end", resolve);
    output.once("error", reject);
  });
  for (const file of files) {
    const body = Buffer.from(
      file.content,
      file.encoding === "base64" ? "base64" : "utf8",
    );
    await new Promise<void>((resolve, reject) =>
      pack.entry(
        { name: file.path, type: "file", size: body.length, mode: 0o600 },
        body,
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  }
  pack.finalize();
  await finished;
  return Buffer.concat(chunks);
}

async function unpackSingleFile(archive: Buffer) {
  const extract = tar.extract();
  let result: { path: string; content: string; encoding: "base64" } | undefined;
  await new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.once("end", () => {
        if ((header.type ?? "file") === "file" && !result) {
          result = {
            path: header.name,
            content: Buffer.concat(chunks).toString("base64"),
            encoding: "base64",
          };
        }
        next();
      });
      stream.once("error", reject);
    });
    extract.once("finish", resolve);
    extract.once("error", reject);
    extract.end(archive);
  });
  if (!result) throw new Error("IRIS_RUNNER_OUTPUT_MISSING");
  return result;
}

class IrisRunnerInstance implements SandboxInstance {
  constructor(
    readonly id: string,
    readonly profile: SandboxProfile,
    private readonly client: IrisRunnerHttpClient,
    readonly expiresAt?: Date,
  ) {}

  async executePython(
    request: PythonComputeRequest,
    options?: { signal?: AbortSignal },
  ) {
    if (request.files?.length) {
      await this.client.uploadArchive(
        `/v1/sessions/${encodeURIComponent(this.id)}/files`,
        await packFiles(request.files),
        options?.signal,
      );
    }
    const startedAt = Date.now();
    const execution = await this.client.request<{
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
    }>({
      method: "POST",
      path: `/v1/sessions/${encodeURIComponent(this.id)}/exec`,
      body: {
        cmd: ["python", "-c", request.code],
        timeoutMs: request.timeoutMs,
      },
      signal: options?.signal,
    });
    const files: PythonComputeResult["files"] = [];
    for (const path of request.outputPaths ?? []) {
      const archive = await this.client.downloadArchive(
        `/v1/sessions/${encodeURIComponent(this.id)}/files?path=${encodeURIComponent(path)}`,
        options?.signal,
      );
      files.push(await unpackSingleFile(archive));
    }
    return {
      executionId: `runner-${this.id}-${startedAt}`,
      ...execution,
      files,
    } satisfies PythonComputeResult;
  }

  cancel(_executionId: string) {
    return this.client.request<void>({
      method: "DELETE",
      path: `/v1/sessions/${encodeURIComponent(this.id)}`,
    });
  }

  destroy() {
    return this.client.request<void>({
      method: "DELETE",
      path: `/v1/sessions/${encodeURIComponent(this.id)}`,
    });
  }
}

export class IrisRunnerProvider implements SandboxProvider {
  readonly name = "iris-runner";

  constructor(private readonly client: IrisRunnerHttpClient) {}

  async status(options?: {
    signal?: AbortSignal;
  }): Promise<SandboxProviderStatus> {
    try {
      const result = await this.client.request<{
        ready: boolean;
        reason?: string;
      }>({
        method: "GET",
        path: "/ready",
        signal: options?.signal,
      });
      return { ...result, provider: this.name, checkedAt: new Date() };
    } catch (error) {
      return {
        ready: false,
        provider: this.name,
        reason:
          error instanceof Error ? error.message : "IRIS_RUNNER_UNAVAILABLE",
        checkedAt: new Date(),
      };
    }
  }

  async create(
    input: {
      scope: SandboxScope;
      profile: SandboxProfile;
      sessionId: string;
      rootRunId: string;
    },
    options?: { signal?: AbortSignal },
  ) {
    const absoluteTimeoutMs =
      input.profile.absoluteTimeoutMs ?? input.profile.idleTimeoutMs * 3;
    const body: SandboxRunnerSessionCreateRequest = {
      identity: {
        sessionId: input.sessionId,
        rootRunId: input.rootRunId,
      },
      profile: {
        id: input.profile.id,
        network: input.profile.network,
      },
      limits: {
        cpuMillis: input.profile.cpuMillis,
        memoryMb: input.profile.memoryMb,
        tmpfsMb: input.profile.diskMb,
        pidsLimit: input.profile.pidsLimit,
        executionTimeoutMs: input.profile.executionTimeoutMs,
        idleTimeoutMs: input.profile.idleTimeoutMs,
        absoluteTimeoutMs,
      },
    };
    const created = await this.client.request<SandboxRunnerSessionResponse>({
      method: "POST",
      path: "/v1/sessions",
      body,
      signal: options?.signal,
    });
    if (!created.id) throw new Error("IRIS_RUNNER_SESSION_ID_MISSING");
    return new IrisRunnerInstance(
      created.id,
      profileFromRunner(created),
      this.client,
      new Date(created.expiresAt),
    );
  }

  async connect(
    instanceId: string,
    profile: SandboxProfile,
    options?: {
      signal?: AbortSignal;
      identity?: { controlPlaneSessionId: string; rootRunId: string };
    },
  ) {
    const current = await this.client.request<SandboxRunnerSessionResponse>({
      method: "GET",
      path: `/v1/sessions/${encodeURIComponent(instanceId)}`,
      signal: options?.signal,
    });
    if (
      current.id !== instanceId ||
      current.status !== "running" ||
      current.profile.id !== profile.id ||
      current.profile.network !== profile.network ||
      (options?.identity &&
        (current.controlPlaneSessionId !==
          options.identity.controlPlaneSessionId ||
          current.rootRunId !== options.identity.rootRunId))
    )
      throw new Error("IRIS_RUNNER_SESSION_MISMATCH");
    return new IrisRunnerInstance(
      instanceId,
      profileFromRunner(current),
      this.client,
      new Date(current.expiresAt),
    );
  }

  inventory(options?: { signal?: AbortSignal }) {
    return this.client.request<SandboxRunnerInventory>({
      method: "GET",
      path: "/v1/inventory",
      signal: options?.signal,
    });
  }
}

function profileFromRunner(
  session: SandboxRunnerSessionResponse,
): SandboxProfile {
  return {
    id: session.profile.id,
    network: session.profile.network,
    cpuMillis: Math.max(1, Math.floor(session.limits.nanoCpus / 1_000_000)),
    memoryMb: Math.max(1, Math.floor(session.limits.memoryBytes / 1_048_576)),
    diskMb: Math.max(1, Math.floor(session.limits.tmpfsBytes / 1_048_576)),
    pidsLimit: session.limits.pidsLimit,
    executionTimeoutMs: session.limits.executionTimeoutMs,
    idleTimeoutMs: session.limits.idleTimeoutMs,
    absoluteTimeoutMs: session.limits.absoluteTimeoutMs,
  };
}
