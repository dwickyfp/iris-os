import type { Tool } from "ai";
import type { CapabilityProvider } from "lib/ai/runtime/capabilities/registry";
import { PYTHON_COMPUTE_TOOL_NAME } from "lib/ai/tools/code/python-compute";
import type { SandboxProvider } from "./contracts";

export function sandboxCapabilityProvider<Context>(input: {
  provider: SandboxProvider;
  pythonCompute: Tool;
}): CapabilityProvider<Context> {
  return {
    name: "sandbox",
    metadata: {
      domain: "compute",
      provider: input.provider.name,
      lifecycle: "run-scoped",
    },
    async readiness() {
      const status = await input.provider.status();
      return {
        ready: status.ready,
        reason: status.reason,
        metadata: { checkedAt: status.checkedAt.toISOString() },
      };
    },
    async eligible() {
      return [
        {
          id: `sandbox:${PYTHON_COMPUTE_TOOL_NAME}`,
          hintIds: [`builtin:${PYTHON_COMPUTE_TOOL_NAME}`],
          key: PYTHON_COMPUTE_TOOL_NAME,
          kind: "sandbox",
          name: "Python Compute",
          description: "Run Python in isolated, run-scoped server compute.",
          surfaces: ["executable", "model", "manual"],
          value: input.pythonCompute,
          risks: ["write", "code", "remote"],
          metadata: {
            provider: input.provider.name,
            profile: "python",
            lifecycleExposed: false,
          },
        },
      ];
    },
  };
}
