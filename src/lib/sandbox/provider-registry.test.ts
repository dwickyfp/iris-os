import { describe, expect, it, vi } from "vitest";
import type { SandboxProvider } from "./contracts";
import { namedIrisRunnerProvider } from "./provider-registry";

const inner: SandboxProvider = {
  name: "iris-runner",
  status: vi.fn(async () => ({
    ready: true,
    provider: "iris-runner",
    checkedAt: new Date(),
  })),
  create: vi.fn(),
  connect: vi.fn(),
  inventory: vi.fn(),
};

describe("sandbox provider registry", () => {
  it("names the same secure runner by explicit platform provider", () => {
    for (const id of ["local-linux", "local-vm", "remote"] as const) {
      const provider = namedIrisRunnerProvider(inner, id);
      expect(provider.name).toBe(id);
    }
  });

  it("maps legacy and auto selection to the host-appropriate provider", () => {
    expect(namedIrisRunnerProvider(inner, "iris-runner", "linux").name).toBe(
      "local-linux",
    );
  });
});
