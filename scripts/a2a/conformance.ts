import type { A2AProfile, RemoteAgentCredential } from "app-types/remote-agent";
import { createA2AProvider, selectA2ABinding } from "lib/a2a/provider";
import type { SecureFetchOptions } from "lib/security/outbound-http";
import { startFakeA2AServer } from "./fake-server";

export type ConformanceCase = {
  name: string;
  passed: boolean;
  evidence: Record<string, unknown>;
  error?: string;
};

export type ConformanceReport = {
  schemaVersion: 1;
  target: string;
  profile?: A2AProfile;
  startedAt: string;
  durationMs: number;
  passed: boolean;
  cases: ConformanceCase[];
};

async function check(
  name: string,
  evidence: Record<string, unknown>,
  operation: () => Promise<void>,
): Promise<ConformanceCase> {
  try {
    await operation();
    return { name, passed: true, evidence };
  } catch (error) {
    return {
      name,
      passed: false,
      evidence,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runA2AConformance(input: {
  endpoint: string;
  credential?: RemoteAgentCredential;
  httpOptions?: SecureFetchOptions;
}): Promise<ConformanceReport> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const provider = createA2AProvider(input.httpOptions);
  let binding: ReturnType<typeof selectA2ABinding> | undefined;
  const cases: ConformanceCase[] = [];
  cases.push(
    await check("agent-card-interface-selection", {}, async () => {
      const card = await provider.discover(input.endpoint, input.credential);
      binding = selectA2ABinding(card);
    }),
  );
  if (binding) {
    const selected = binding;
    cases[0].evidence = { binding: selected };
    const sendEvidence: Record<string, unknown> = {
      expectedState: "completed",
    };
    const messageEvidence: Record<string, unknown> = {};
    const getEvidence: Record<string, unknown> = {};
    const cancelEvidence: Record<string, unknown> = {};
    cases.push(
      await check("task-send-result-and-state", sendEvidence, async () => {
        const result = await provider.sendTask(
          selected,
          {
            message: { role: "user", messageId: "conformance-1", parts: [] },
          },
          input.credential,
          "conformance-send-task",
        );
        if ("kind" in result || result.state !== "completed") {
          throw new Error("Send did not return a completed Task");
        }
        sendEvidence.result = {
          id: result.id,
          state: result.state,
        };
      }),
      await check("direct-message-send-result", messageEvidence, async () => {
        const result = await provider.sendTask(
          selected,
          {
            message: { role: "user", messageId: "conformance-2", parts: [] },
            metadata: { direct: true },
          },
          input.credential,
          "conformance-send-message",
        );
        if (!("kind" in result) || result.kind !== "message") {
          throw new Error("Send did not return a direct Message");
        }
        messageEvidence.resultKind = result.kind;
      }),
      await check("get-task", getEvidence, async () => {
        const task = await provider.getTask(
          selected,
          "task-deterministic-1",
          input.credential,
        );
        if (task.id !== "task-deterministic-1") {
          throw new Error("GetTask returned the wrong task");
        }
        getEvidence.state = task.state;
      }),
      await check(
        "cancel-task-state-normalization",
        cancelEvidence,
        async () => {
          const task = await provider.cancelTask(
            selected,
            "task-deterministic-1",
            input.credential,
          );
          if (task.state !== "cancelled") {
            throw new Error(`Cancel state normalized to ${task.state}`);
          }
          cancelEvidence.state = task.state;
        },
      ),
    );
  }
  return {
    schemaVersion: 1,
    target: input.endpoint,
    profile: binding?.profile,
    startedAt,
    durationMs: Date.now() - started,
    passed: cases.every((item) => item.passed),
    cases,
  };
}

export async function runLocalA2AConformance() {
  const reports: ConformanceReport[] = [];
  for (const profile of [
    "legacy-0.3-jsonrpc",
    "current-1.0-jsonrpc",
  ] as const) {
    const server = await startFakeA2AServer(profile);
    try {
      const report = await runA2AConformance({
        endpoint: server.endpoint,
        credential: { type: "bearer", value: "loopback-token" },
        httpOptions: { allowHttp: true, allowLoopback: true },
      });
      report.cases.push({
        name: "wire-evidence",
        passed: server.evidence.every(
          (entry) =>
            entry.version ===
              (profile === "legacy-0.3-jsonrpc" ? "0.3" : "1.0") &&
            entry.contentType === "application/json" &&
            entry.authorization === "Bearer loopback-token",
        ),
        evidence: { requests: server.evidence },
      });
      report.passed = report.cases.every((item) => item.passed);
      reports.push(report);
    } finally {
      await server.close();
    }
  }
  return reports;
}
