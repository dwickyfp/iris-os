import type {
  SandboxInstance,
  SandboxProvider,
  SandboxProviderStatus,
  SandboxRunnerInventory,
} from "./contracts";

export type SandboxProviderId =
  | "local-linux"
  | "local-vm"
  | "remote"
  | "unavailable";

export function normalizeSandboxProviderId(
  configured: string,
  platform: NodeJS.Platform = process.platform,
): SandboxProviderId {
  if (
    configured === "local-linux" ||
    configured === "local-vm" ||
    configured === "remote"
  )
    return configured;
  if (configured === "auto")
    return platform === "linux" ? "local-linux" : "local-vm";
  if (configured === "iris-runner")
    return platform === "linux" ? "local-linux" : "local-vm";
  throw new Error("SANDBOX_PROVIDER_UNKNOWN");
}

class NamedIrisRunnerProvider implements SandboxProvider {
  readonly name: SandboxProviderId;
  constructor(
    private readonly inner: SandboxProvider,
    readonly id: Exclude<SandboxProviderId, "unavailable">,
  ) {
    this.name = id;
  }
  status(options?: { signal?: AbortSignal }) {
    return this.inner.status(options);
  }
  create(
    input: Parameters<SandboxProvider["create"]>[0],
    options?: { signal?: AbortSignal },
  ) {
    return this.inner.create(input, options);
  }
  connect(
    instanceId: string,
    profile: any,
    options?: { signal?: AbortSignal },
  ) {
    return this.inner.connect(
      instanceId,
      profile,
      options,
    ) as Promise<SandboxInstance>;
  }
  inventory(options?: { signal?: AbortSignal }) {
    return this.inner.inventory(options);
  }
}

export class UnavailableSandboxProvider implements SandboxProvider {
  readonly name = "unavailable" as const;
  async status(): Promise<SandboxProviderStatus> {
    return {
      ready: false,
      provider: this.name,
      reason: "SANDBOX_PROVIDER_NOT_CONFIGURED",
      checkedAt: new Date(),
    };
  }
  async create(): Promise<SandboxInstance> {
    throw new Error("SANDBOX_PROVIDER_NOT_CONFIGURED");
  }
  async connect(): Promise<SandboxInstance> {
    throw new Error("SANDBOX_PROVIDER_NOT_CONFIGURED");
  }
  inventory(): Promise<SandboxRunnerInventory> {
    throw new Error("SANDBOX_PROVIDER_NOT_CONFIGURED");
  }
}

export function namedIrisRunnerProvider(
  inner: SandboxProvider,
  providerId: string,
  platform: NodeJS.Platform = process.platform,
): SandboxProvider {
  const normalized = normalizeSandboxProviderId(providerId, platform);
  if (normalized === "unavailable") return new UnavailableSandboxProvider();
  return new NamedIrisRunnerProvider(inner, normalized);
}
