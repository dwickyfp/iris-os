import { randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import type {
  SandboxRunnerSessionCreateRequest,
  SandboxRunnerSessionLimits,
} from "../sandbox/contracts";
import { type ArchiveLimits, validateAndRepackArchive } from "./archive";
import type { SandboxRunnerConfig } from "./config";
import { DockerApiError, DockerClient, dockerPath } from "./docker";
import { decodeDockerMultiplexedStream } from "./exec";

const OWNER_LABEL = "com.iris-os.sandbox-runner";
const SESSION_LABEL = "com.iris-os.sandbox-session";
const CREATED_LABEL = "com.iris-os.sandbox-created-ms";

type DockerContainer = {
  Id: string;
  Labels?: Record<string, string>;
  State?: { Running?: boolean; Status?: string };
};

type Session = {
  id: string;
  containerId: string;
  profile: SandboxRunnerSessionCreateRequest["profile"];
  limits: SandboxRunnerSessionLimits;
  createdAt: number;
  lastUsedAt: number;
};

export class ReadinessError extends Error {
  readonly code = "RUNSC_UNAVAILABLE";
}

export class NotFoundError extends Error {}

export class ValidationError extends Error {}
export class ExecTimeoutError extends Error {}
export class CapacityError extends Error {}

export class SandboxRunner {
  readonly docker: DockerClient;
  private readonly sessions = new Map<string, Session>();
  private readonly activeExecSessions = new Set<string>();
  private ready = false;
  private reaper?: NodeJS.Timeout;
  private creatingSessions = 0;

  constructor(
    readonly config: SandboxRunnerConfig,
    docker?: DockerClient,
  ) {
    this.docker = docker ?? new DockerClient(config.SANDBOX_RUNNER_SOCKET);
  }

  get readiness() {
    return this.ready;
  }

  private archiveLimits(): ArchiveLimits {
    return {
      maxFiles: this.config.SANDBOX_RUNNER_MAX_ARCHIVE_FILES,
      maxFileBytes: this.config.SANDBOX_RUNNER_MAX_FILE_BYTES,
      maxTotalBytes: this.config.SANDBOX_RUNNER_MAX_ARCHIVE_BYTES,
    };
  }

  private createConfig(
    sessionId: string,
    limits: SandboxRunnerSessionLimits = this.maximumLimits(),
    network: "none" | "egress" = "none",
    command = ["sleep", "infinity"],
  ) {
    if (network === "egress" && !this.config.SANDBOX_RUNNER_EGRESS_NETWORK) {
      throw new ValidationError("Egress profile is not configured");
    }
    const networkMode =
      network === "egress" ? this.config.SANDBOX_RUNNER_EGRESS_NETWORK : "none";
    return {
      Image: this.config.SANDBOX_RUNNER_IMAGE,
      Cmd: command,
      User: "10001:10001",
      WorkingDir: "/workspace",
      NetworkDisabled: network === "none",
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      OpenStdin: false,
      StdinOnce: false,
      Tty: false,
      Labels: {
        [OWNER_LABEL]: "true",
        [SESSION_LABEL]: sessionId,
        [CREATED_LABEL]: String(Date.now()),
      },
      HostConfig: {
        Runtime: "runsc",
        ReadonlyRootfs: true,
        NetworkMode: networkMode,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: limits.memoryBytes,
        MemorySwap: limits.memoryBytes,
        NanoCpus: limits.nanoCpus,
        PidsLimit: limits.pidsLimit,
        OomKillDisable: false,
        Privileged: false,
        AutoRemove: false,
        Init: true,
        IpcMode: "private",
        UTSMode: "private",
        CgroupnsMode: "private",
        Binds: [],
        Mounts: [],
        Devices: [],
        DeviceRequests: [],
        Tmpfs: {
          "/tmp": `rw,noexec,nosuid,nodev,size=${limits.tmpfsBytes},uid=10001,gid=10001,mode=700`,
          "/workspace": `rw,noexec,nosuid,nodev,size=${limits.tmpfsBytes},uid=10001,gid=10001,mode=700`,
        },
      },
    };
  }

  private maximumLimits(): SandboxRunnerSessionLimits {
    return {
      nanoCpus: this.config.SANDBOX_RUNNER_NANO_CPUS,
      memoryBytes: this.config.SANDBOX_RUNNER_MEMORY_BYTES,
      tmpfsBytes: this.config.SANDBOX_RUNNER_TMPFS_BYTES,
      pidsLimit: this.config.SANDBOX_RUNNER_PIDS_LIMIT,
      executionTimeoutMs: this.config.SANDBOX_RUNNER_EXEC_TIMEOUT_MS,
      idleTimeoutMs: this.config.SANDBOX_RUNNER_IDLE_TTL_MS,
      absoluteTimeoutMs: this.config.SANDBOX_RUNNER_SESSION_TTL_MS,
    };
  }

  private clampLimits(
    requested: SandboxRunnerSessionCreateRequest["limits"],
  ): SandboxRunnerSessionLimits {
    const maximum = this.maximumLimits();
    const mib = 1024 * 1024;
    return {
      nanoCpus: Math.min(requested.cpuMillis * 1_000_000, maximum.nanoCpus),
      memoryBytes: Math.min(requested.memoryMb * mib, maximum.memoryBytes),
      tmpfsBytes: Math.min(requested.tmpfsMb * mib, maximum.tmpfsBytes),
      pidsLimit: Math.min(
        requested.pidsLimit ?? maximum.pidsLimit,
        maximum.pidsLimit,
      ),
      executionTimeoutMs: Math.min(
        requested.executionTimeoutMs,
        maximum.executionTimeoutMs,
      ),
      idleTimeoutMs: Math.min(requested.idleTimeoutMs, maximum.idleTimeoutMs),
      absoluteTimeoutMs: Math.min(
        requested.absoluteTimeoutMs,
        maximum.absoluteTimeoutMs,
      ),
    };
  }

  async start(): Promise<void> {
    this.ready = false;
    try {
      await this.docker.request("GET", "/_ping");
      await this.docker.request("GET", "/version");
      const info = await this.docker.request<{
        Runtimes?: Record<string, unknown>;
      }>("GET", "/info");
      if (!Object.hasOwn(info.Runtimes ?? {}, "runsc"))
        throw new Error("runsc runtime is not registered");
      const image = await this.docker.request<{
        Id?: string;
        RepoDigests?: string[];
      }>("GET", `/images/${dockerPath(this.config.SANDBOX_RUNNER_IMAGE)}/json`);
      const imageMatches = this.config.SANDBOX_RUNNER_IMAGE.startsWith(
        "sha256:",
      )
        ? image.Id === this.config.SANDBOX_RUNNER_IMAGE
        : image.RepoDigests?.includes(this.config.SANDBOX_RUNNER_IMAGE);
      if (!imageMatches) {
        throw new Error("Configured image digest is not present locally");
      }
      await this.cleanupOwnedContainers();
      await this.runCanary();
      this.ready = true;
      this.reaper = setInterval(
        () =>
          void this.reap().catch((error) =>
            console.error("sandbox reaper failed", error),
          ),
        this.config.SANDBOX_RUNNER_REAPER_INTERVAL_MS,
      );
      this.reaper.unref();
    } catch (error) {
      throw new ReadinessError(
        `runsc readiness checks failed: ${(error as Error).message}`,
      );
    }
  }

  async stop(): Promise<void> {
    this.ready = false;
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
    await Promise.allSettled(
      [...this.sessions.values()].map((session) => this.remove(session)),
    );
  }

  private async runCanary() {
    const id = `canary-${randomBytes(12).toString("hex")}`;
    const created = await this.docker.request<{ Id: string }>(
      "POST",
      `/containers/create?name=${dockerPath(`iris-sandbox-${id}`)}`,
      this.createConfig(id, this.maximumLimits(), "none", [
        "sh",
        "-c",
        'test "$(id -u)" = 10001 && test -w /workspace && test ! -w /',
      ]),
    );
    try {
      await this.docker.request("POST", `/containers/${created.Id}/start`);
      const result = await this.docker.request<{ StatusCode: number }>(
        "POST",
        `/containers/${created.Id}/wait?condition=not-running`,
      );
      if (result.StatusCode !== 0)
        throw new Error(`runsc canary exited ${result.StatusCode}`);
    } finally {
      await this.forceRemove(created.Id).catch(() => undefined);
    }
  }

  private async cleanupOwnedContainers() {
    const filters = encodeURIComponent(
      JSON.stringify({ label: [`${OWNER_LABEL}=true`] }),
    );
    const containers = await this.docker.request<DockerContainer[]>(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
    );
    await Promise.all(
      containers.map((container) => this.forceRemove(container.Id)),
    );
  }

  async createSession(
    input: SandboxRunnerSessionCreateRequest,
  ): Promise<Session> {
    if (!this.ready) throw new ReadinessError("runsc is not ready");
    if (
      this.sessions.size + this.creatingSessions >=
      this.config.SANDBOX_RUNNER_MAX_CONCURRENT_SESSIONS
    ) {
      throw new CapacityError("Maximum concurrent sessions reached");
    }
    this.creatingSessions += 1;
    const id = randomBytes(24).toString("base64url");
    const createdAt = Date.now();
    const limits = this.clampLimits(input.limits);
    let containerId: string | undefined;
    try {
      const created = await this.docker.request<{ Id: string }>(
        "POST",
        `/containers/create?name=${dockerPath(`iris-sandbox-${id}`)}`,
        this.createConfig(id, limits, input.profile.network),
      );
      containerId = created.Id;
      await this.docker.request("POST", `/containers/${created.Id}/start`);
      const session = {
        id,
        containerId: created.Id,
        profile: input.profile,
        limits,
        createdAt,
        lastUsedAt: createdAt,
      };
      this.sessions.set(id, session);
      return session;
    } catch (error) {
      if (containerId)
        await this.forceRemove(containerId).catch(() => undefined);
      throw error;
    } finally {
      this.creatingSessions -= 1;
    }
  }

  async getSession(id: string) {
    const session = this.requireSession(id);
    try {
      const container = await this.docker.request<DockerContainer>(
        "GET",
        `/containers/${session.containerId}/json`,
      );
      return {
        id: session.id,
        profile: session.profile,
        limits: session.limits,
        createdAt: new Date(session.createdAt).toISOString(),
        expiresAt: new Date(this.expiresAt(session)).toISOString(),
        status: container.State?.Status ?? "unknown",
      };
    } catch (error) {
      if (error instanceof DockerApiError && error.statusCode === 404)
        this.sessions.delete(id);
      throw error;
    }
  }

  async deleteSession(id: string): Promise<void> {
    await this.remove(this.requireSession(id));
  }

  async putFiles(id: string, input: NodeJS.ReadableStream): Promise<void> {
    const session = this.requireSession(id);
    this.touch(session);
    const limiter = new Transform({
      transform: (chunk, _encoding, callback) => {
        limiterBytes += chunk.length;
        callback(
          limiterBytes > this.config.SANDBOX_RUNNER_MAX_BODY_BYTES
            ? new ValidationError("Request body exceeded limit")
            : undefined,
          chunk,
        );
      },
    });
    let limiterBytes = 0;
    input.pipe(limiter);
    const archive = await validateAndRepackArchive(
      limiter,
      this.archiveLimits(),
    );
    await this.docker.request(
      "PUT",
      `/containers/${session.containerId}/archive?path=${encodeURIComponent("/workspace")}&noOverwriteDirNonDir=true`,
      archive,
    );
  }

  async getFiles(id: string, requestedPath: string): Promise<Buffer> {
    const session = this.requireSession(id);
    this.touch(session);
    const relative = validateRelativePath(requestedPath);
    const response = await this.docker.stream(
      "GET",
      `/containers/${session.containerId}/archive?path=${encodeURIComponent(`/workspace/${relative}`)}`,
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.stream.resume();
      throw new DockerApiError(response.statusCode, "archive read failed");
    }
    return validateAndRepackArchive(response.stream, {
      ...this.archiveLimits(),
      workspacePrefix: true,
    });
  }

  async exec(
    id: string,
    command: unknown,
    signal?: AbortSignal,
    requestedTimeoutMs?: number,
  ) {
    const session = this.requireSession(id);
    this.touch(session);
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      command.length > 64 ||
      command.some(
        (part) =>
          typeof part !== "string" || part.length === 0 || part.length > 4_096,
      )
    ) {
      throw new ValidationError("cmd must be a non-empty bounded string array");
    }
    if (this.activeExecSessions.has(id))
      throw new ValidationError("Sandbox session already has an active execution");
    this.activeExecSessions.add(id);
    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = Math.min(
      Math.max(requestedTimeoutMs ?? session.limits.executionTimeoutMs, 100),
      session.limits.executionTimeoutMs,
    );
    const startedAt = Date.now();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const created = await this.docker.request<{ Id: string }>(
        "POST",
        `/containers/${session.containerId}/exec`,
        {
          AttachStdout: true,
          AttachStderr: true,
          AttachStdin: false,
          Tty: false,
          Cmd: command,
          User: "10001:10001",
          WorkingDir: "/workspace",
          Privileged: false,
        },
        controller.signal,
      );
      const response = await this.docker.stream(
        "POST",
        `/exec/${created.Id}/start`,
        { Detach: false, Tty: false },
        controller.signal,
      );
      if (response.statusCode !== 200)
        throw new DockerApiError(response.statusCode, "exec start failed");
      const output = await decodeDockerMultiplexedStream(
        response.stream,
        this.config.SANDBOX_RUNNER_MAX_EXEC_OUTPUT_BYTES,
      );
      const inspected = await this.docker.request<{
        ExitCode: number;
        Running: boolean;
      }>("GET", `/exec/${created.Id}/json`, undefined, controller.signal);
      if (inspected.Running)
        throw new Error("Exec stream ended while process was running");
      return {
        exitCode: inspected.ExitCode,
        stdout: output.stdout.toString("utf8"),
        stderr: output.stderr.toString("utf8"),
        durationMs: Math.max(0, Date.now() - startedAt),
      };
    } catch (error) {
      if (controller.signal.aborted || signal?.aborted) {
        await this.remove(session).catch(() => undefined);
        if (timedOut) throw new ExecTimeoutError("Sandbox execution timed out");
        throw new ValidationError(
          "Exec aborted or timed out; session destroyed",
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      this.activeExecSessions.delete(id);
      if (this.sessions.has(session.id)) this.touch(session);
    }
  }

  async reap(now = Date.now()): Promise<void> {
    const expired = [...this.sessions.values()].filter(
      (session) => now >= this.expiresAt(session),
    );
    await Promise.all(expired.map((session) => this.remove(session)));
  }

  private requireSession(id: string): Session {
    if (!/^[A-Za-z0-9_-]{32}$/.test(id))
      throw new NotFoundError("Session not found");
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundError("Session not found");
    return session;
  }

  private async remove(session: Session) {
    this.sessions.delete(session.id);
    await this.forceRemove(session.containerId);
  }

  private touch(session: Session, now = Date.now()) {
    session.lastUsedAt = now;
  }

  private expiresAt(session: Session) {
    return Math.min(
      session.lastUsedAt + session.limits.idleTimeoutMs,
      session.createdAt + session.limits.absoluteTimeoutMs,
    );
  }

  private async forceRemove(containerId: string) {
    try {
      await this.docker.request(
        "DELETE",
        `/containers/${containerId}?force=true&v=true`,
      );
    } catch (error) {
      if (!(error instanceof DockerApiError && error.statusCode === 404))
        throw error;
    }
  }
}

function validateRelativePath(value: string): string {
  if (value === ".") return ".";
  if (
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/")
  ) {
    throw new ValidationError("Invalid file path");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new ValidationError("Invalid file path");
  }
  return parts.join("/");
}
