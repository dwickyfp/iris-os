import "server-only";

import { recordRuntimeActivityEvent } from "lib/activity/service";
import { ArtifactService } from "lib/ai/artifacts";
import { policyEngine } from "lib/ai/runtime/policy-engine";
import { createPythonComputeTool } from "lib/ai/tools/code/python-compute";
import { artifactRepository, sandboxRepository } from "lib/db/repository";
import { serverFileStorage } from "lib/file-storage";
import { createSandboxArtifactHook } from "./artifact-bridge";
import { safeSandboxRelativePath } from "./artifact-path";
import { DEFAULT_SANDBOX_ARTIFACT_LIMITS } from "./artifact-types";
import { sandboxServerConfig } from "./config.server";
import type { SandboxEventSink, SandboxPolicyGate } from "./contracts";
import {
  FetchIrisRunnerHttpClient,
  IrisRunnerProvider,
} from "./iris-runner-provider";
import { SandboxManager } from "./manager";

const config = sandboxServerConfig();

export const sandboxProvider = new IrisRunnerProvider(
  new FetchIrisRunnerHttpClient(
    config.runnerUrl ?? "http://127.0.0.1:8787",
    config.runnerToken,
  ),
);

const policy: SandboxPolicyGate = {
  async authorize({ action, profile, scope }) {
    if (!config.enabled) throw new Error("SANDBOX_DISABLED");
    if (profile.network !== "none") throw new Error("SANDBOX_NETWORK_DENIED");
    if (action === "sandbox.execute_python" && profile.id !== config.profile.id)
      throw new Error("SANDBOX_PROFILE_DENIED");
    const decision = policyEngine.evaluate({
      actor: { type: "system", userId: scope.userId },
      capability: {
        id: "sandbox:python_compute",
        key: "python_compute",
        kind: "sandbox",
        risks: ["write", "code", "remote"],
      },
      action,
      resource: `sandbox:${profile.id}`,
      args: {},
      destination: { kind: "remote", id: sandboxProvider.name },
      runtime: {
        kind: "worker",
        approvalPolicy: "never",
        runId: scope.runId,
      },
    });
    if (decision.result === "deny") throw new Error("SANDBOX_POLICY_DENIED");
  },
};

const events: SandboxEventSink = {
  async record({ type, scope, sessionId, executionId, payload }) {
    await recordRuntimeActivityEvent(scope.userId, {
      actorType: "system",
      scopeType: scope.taskId
        ? "task"
        : scope.workspaceId
          ? "workspace"
          : "global",
      scopeId: scope.taskId ?? scope.workspaceId ?? null,
      eventType: type,
      subjectType: "sandbox",
      subjectId: sessionId,
      runId: scope.runId,
      taskId: scope.taskId,
      payload: { sessionId, executionId, ...payload },
    });
  },
};

const artifactService = new ArtifactService(
  serverFileStorage,
  artifactRepository,
);

export const sandboxManager = new SandboxManager({
  provider: sandboxProvider,
  repository: sandboxRepository,
  policy,
  events,
  artifacts: createSandboxArtifactHook(artifactService),
});

export const pythonComputeTool = createPythonComputeTool({
  manager: sandboxManager,
  profile: config.profile,
  maxComputeMs: config.profile.executionTimeoutMs * 5,
  async stageArtifacts({ context, artifacts }) {
    let totalBytes = 0;
    return Promise.all(
      artifacts.map(async ({ artifactId, destination }) => {
        const path = safeSandboxRelativePath(destination);
        const { bytes } = await artifactService.resolveForSandboxInput({
          artifactId,
          userId: context.userId,
          sourceRunId: context.runId,
        });
        totalBytes += bytes.byteLength;
        if (
          bytes.byteLength > DEFAULT_SANDBOX_ARTIFACT_LIMITS.maxInputFileBytes
        )
          throw new Error("SANDBOX_ARTIFACT_INPUT_FILE_SIZE_EXCEEDED");
        if (totalBytes > DEFAULT_SANDBOX_ARTIFACT_LIMITS.maxInputTotalBytes)
          throw new Error("SANDBOX_ARTIFACT_INPUT_TOTAL_SIZE_EXCEEDED");
        return {
          path,
          content: bytes.toString("base64"),
          encoding: "base64" as const,
        };
      }),
    );
  },
});

export const sandboxCapability = config.enabled
  ? { provider: sandboxProvider, pythonCompute: pythonComputeTool }
  : undefined;

export function workflowSandboxServices(_runId: string) {
  return {
    sandbox: {
      manager: sandboxManager,
      profile: config.profile,
      maxComputeMs: config.profile.executionTimeoutMs * 5,
    },
  };
}
