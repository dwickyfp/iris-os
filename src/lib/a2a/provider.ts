import "server-only";

import { randomUUID } from "node:crypto";
import type {
  A2ABinding,
  A2ADirectMessage,
  A2ASendResult,
  A2ATask,
  A2ATaskState,
  AgentCard,
  RemoteAgentCredential,
} from "app-types/remote-agent";
import {
  type SecureFetchOptions,
  secureJsonFetch,
} from "lib/security/outbound-http";
import { z } from "zod";

const AgentInterfaceSchema = z.object({
  url: z.string().url().max(2_048),
  protocolBinding: z.string().min(1).max(128),
  protocolVersion: z.string().min(1).max(32),
});

const AgentCardSchema = z
  .object({
    name: z.string().min(1).max(256),
    description: z.string().max(8_192).optional(),
    url: z.string().url().max(2_048).optional(),
    version: z.string().max(64).optional(),
    protocolVersion: z.string().max(32).optional(),
    preferredTransport: z.string().max(128).optional(),
    additionalInterfaces: z.array(AgentInterfaceSchema).max(32).optional(),
    supportedInterfaces: z.array(AgentInterfaceSchema).max(32).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    defaultInputModes: z.array(z.string().max(256)).max(128).optional(),
    defaultOutputModes: z.array(z.string().max(256)).max(128).optional(),
    skills: z.array(z.record(z.string(), z.unknown())).max(1_024).optional(),
  })
  .loose();

const RpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

const TASK_STATES: Record<string, A2ATaskState> = {
  submitted: "submitted",
  working: "working",
  "input-required": "input_required",
  input_required: "input_required",
  "auth-required": "auth_required",
  auth_required: "auth_required",
  completed: "completed",
  failed: "failed",
  canceled: "cancelled",
  cancelled: "cancelled",
  rejected: "rejected",
};

const METHODS = {
  "legacy-0.3-jsonrpc": {
    send: "message/send",
    get: "tasks/get",
    cancel: "tasks/cancel",
  },
  "current-1.0-jsonrpc": {
    send: "SendMessage",
    get: "GetTask",
    cancel: "CancelTask",
  },
} as const;

function credentialHeaders(
  credential?: RemoteAgentCredential,
): Record<string, string> {
  if (!credential) return {};
  return credential.type === "bearer"
    ? { Authorization: `Bearer ${credential.value}` }
    : { [credential.headerName]: credential.value };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Remote ${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

function normalizedState(value: unknown): A2ATaskState {
  if (typeof value !== "string") return "unknown";
  return (
    TASK_STATES[
      value
        .toLowerCase()
        .replace(/^task_state_/, "")
        .replaceAll("-", "_")
    ] ?? "unknown"
  );
}

function requireIdentifier(value: string, label: string) {
  if (!value.trim() || value.length > 512) {
    throw new Error(`${label} must contain 1 to 512 characters`);
  }
  return value;
}

export function normalizeA2ATask(value: unknown): A2ATask {
  const raw = asRecord(value, "task");
  const id = raw.id;
  if (typeof id !== "string" || !id || id.length > 512) {
    throw new Error("Remote task has no valid id");
  }
  const status = asRecord(raw.status ?? {}, "task status");
  const metadata =
    raw.metadata &&
    typeof raw.metadata === "object" &&
    !Array.isArray(raw.metadata)
      ? (raw.metadata as Record<string, unknown>)
      : undefined;
  return {
    id,
    contextId:
      typeof raw.contextId === "string" && raw.contextId.length <= 512
        ? raw.contextId
        : undefined,
    state: normalizedState(status.state),
    statusMessage: status.message,
    artifacts:
      "artifacts" in raw
        ? Array.isArray(raw.artifacts)
          ? raw.artifacts
          : [raw.artifacts]
        : undefined,
    history: Array.isArray(raw.history) ? raw.history : undefined,
    metadata,
    raw,
  };
}

function normalizeDirectMessage(value: unknown): A2ADirectMessage {
  const message = asRecord(value, "message");
  if (!Array.isArray(message.parts) || typeof message.role !== "string") {
    throw new Error("Remote message is malformed");
  }
  return { kind: "message", message };
}

function isJsonRpc(binding: string) {
  return ["jsonrpc", "json-rpc", "json-rpc 2.0"].includes(
    binding.toLowerCase(),
  );
}

function majorMinor(version: string) {
  return version.match(/^(\d+\.\d+)(?:\.\d+)?$/)?.[1];
}

export function selectA2ABinding(card: AgentCard): A2ABinding {
  if (card.supportedInterfaces) {
    for (const candidate of card.supportedInterfaces) {
      if (!isJsonRpc(candidate.protocolBinding)) continue;
      const version = majorMinor(candidate.protocolVersion);
      if (version === "1.0") {
        return {
          url: candidate.url,
          version,
          profile: "current-1.0-jsonrpc",
        };
      }
      if (version === "0.3") {
        return {
          url: candidate.url,
          version,
          profile: "legacy-0.3-jsonrpc",
        };
      }
    }
    throw new Error("Agent Card has no supported A2A JSON-RPC interface");
  }

  const version = card.protocolVersion && majorMinor(card.protocolVersion);
  const transport = card.preferredTransport ?? "JSONRPC";
  if (version === "0.3" && card.url && isJsonRpc(transport)) {
    return { url: card.url, version, profile: "legacy-0.3-jsonrpc" };
  }
  throw new Error("Agent Card does not declare a supported A2A interface");
}

export type A2AProvider = ReturnType<typeof createA2AProvider>;

export function createA2AProvider(httpOptions: SecureFetchOptions = {}) {
  async function request(
    binding: A2ABinding,
    method: string,
    params: Record<string, unknown>,
    credential?: RemoteAgentCredential,
    requestId: string = randomUUID(),
    signal?: AbortSignal,
  ) {
    const value = await secureJsonFetch(
      binding.url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "A2A-Version": binding.version,
          "Content-Type": "application/json",
          ...credentialHeaders(credential),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method,
          params,
        }),
        signal,
      },
      httpOptions,
    );
    const response = RpcResponseSchema.parse(value);
    if (String(response.id) !== requestId) {
      throw new Error("Remote JSON-RPC response id does not match request");
    }
    if (response.error) {
      throw new Error(
        `Remote JSON-RPC error ${response.error.code}: ${response.error.message}`,
      );
    }
    if (response.result === undefined) {
      throw new Error("Remote JSON-RPC response has no result");
    }
    return response.result;
  }

  return {
    async discover(
      endpointUrl: string,
      credential?: RemoteAgentCredential,
      signal?: AbortSignal,
    ): Promise<AgentCard> {
      const cardUrl = new URL("/.well-known/agent-card.json", endpointUrl);
      const value = await secureJsonFetch(
        cardUrl,
        {
          headers: {
            Accept: "application/json",
            ...credentialHeaders(credential),
          },
          signal,
        },
        httpOptions,
      );
      return AgentCardSchema.parse(value) as AgentCard;
    },

    async sendTask(
      binding: A2ABinding,
      input: {
        id?: string;
        contextId?: string;
        message: unknown;
        configuration?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
      },
      credential?: RemoteAgentCredential,
      requestId?: string,
      signal?: AbortSignal,
    ): Promise<A2ASendResult> {
      const result = await request(
        binding,
        METHODS[binding.profile].send,
        input,
        credential,
        requestId,
        signal,
      );
      if (binding.profile === "current-1.0-jsonrpc") {
        const wrapped = asRecord(result, "send result");
        if ("task" in wrapped === "message" in wrapped) {
          throw new Error(
            "Remote send result must contain one Task or Message",
          );
        }
        return "task" in wrapped
          ? normalizeA2ATask(wrapped.task)
          : normalizeDirectMessage(wrapped.message);
      }
      const unwrapped = asRecord(result, "send result");
      return "status" in unwrapped
        ? normalizeA2ATask(unwrapped)
        : normalizeDirectMessage(unwrapped);
    },

    async getTask(
      binding: A2ABinding,
      taskId: string,
      credential?: RemoteAgentCredential,
      signal?: AbortSignal,
    ) {
      return normalizeA2ATask(
        await request(
          binding,
          METHODS[binding.profile].get,
          { id: requireIdentifier(taskId, "Task id") },
          credential,
          undefined,
          signal,
        ),
      );
    },

    async cancelTask(
      binding: A2ABinding,
      taskId: string,
      credential?: RemoteAgentCredential,
      signal?: AbortSignal,
    ) {
      return normalizeA2ATask(
        await request(
          binding,
          METHODS[binding.profile].cancel,
          { id: requireIdentifier(taskId, "Task id") },
          credential,
          undefined,
          signal,
        ),
      );
    },
  };
}
