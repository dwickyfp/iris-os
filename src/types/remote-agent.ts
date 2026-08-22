import { z } from "zod";
import type { CapabilityHealth } from "./capability-health";

export const RemoteAgentStatusSchema = z.enum(["active", "disabled"]);
export const RemoteAgentCredentialSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bearer"),
    value: z.string().trim().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("api_key"),
    value: z.string().trim().min(1).max(8_192),
    headerName: z
      .string()
      .trim()
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
      .refine((value) => {
        const name = value.toLowerCase();
        return (
          ![
            "a2a-version",
            "accept",
            "authorization",
            "connection",
            "content-length",
            "content-type",
            "cookie",
            "forwarded",
            "host",
            "origin",
            "proxy-authorization",
            "proxy-connection",
            "referer",
            "set-cookie",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade",
          ].includes(name) && !name.startsWith("x-forwarded-")
        );
      }, "Credential header name is not allowed")
      .default("X-API-Key"),
  }),
]);

const RemoteAgentFieldsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  endpointUrl: z.string().trim().url().max(2_048),
  status: RemoteAgentStatusSchema,
});

export const RemoteAgentCreateSchema = RemoteAgentFieldsSchema.extend({
  status: RemoteAgentStatusSchema.default("active"),
  credential: RemoteAgentCredentialSchema.optional(),
});

export const RemoteAgentUpdateSchema = RemoteAgentFieldsSchema.partial()
  .extend({
    credential: RemoteAgentCredentialSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one remote agent field must be updated",
  });

const A2AIdentifierSchema = z.string().trim().min(1).max(512);
const BoundedMetadataSchema = z
  .record(z.string().min(1).max(256), z.unknown())
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= 65_536,
    "A2A metadata exceeds 65536 bytes",
  );

export const A2ATaskSendSchema = z.object({
  id: A2AIdentifierSchema.optional(),
  contextId: A2AIdentifierSchema.optional(),
  message: z.unknown(),
  configuration: BoundedMetadataSchema.optional(),
  metadata: BoundedMetadataSchema.optional(),
});

export const AgentRunResumeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("input"),
    message: z.string().trim().min(1).max(8_000),
  }),
  z.object({
    kind: z.literal("credential"),
    credential: RemoteAgentCredentialSchema,
  }),
]);

export type AgentRunResumeInput = z.infer<typeof AgentRunResumeSchema>;

export type RemoteAgentStatus = z.infer<typeof RemoteAgentStatusSchema>;
export type RemoteAgentCredential = z.infer<typeof RemoteAgentCredentialSchema>;
export type RemoteAgentCreateInput = z.input<typeof RemoteAgentCreateSchema>;
export type RemoteAgentCreateData = z.output<typeof RemoteAgentCreateSchema>;
export type RemoteAgentUpdateInput = z.infer<typeof RemoteAgentUpdateSchema>;

export type AgentCard = {
  name: string;
  description?: string;
  url?: string;
  version?: string;
  protocolVersion?: string;
  preferredTransport?: string;
  additionalInterfaces?: A2AAgentInterface[];
  supportedInterfaces?: A2AAgentInterface[];
  capabilities?: Record<string, unknown>;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type A2AProfile = "legacy-0.3-jsonrpc" | "current-1.0-jsonrpc";

export type A2AAgentInterface = {
  url: string;
  protocolBinding: string;
  protocolVersion: string;
};

export type A2ABinding = {
  url: string;
  version: "0.3" | "1.0";
  profile: A2AProfile;
};

export type RemoteAgent = {
  id: string;
  userId: string;
  name: string;
  endpointUrl: string;
  status: RemoteAgentStatus;
  credentialType: RemoteAgentCredential["type"] | null;
  credentialHeader: string | null;
  encryptedCredential: string | null;
  agentCard: AgentCard | null;
  discoveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicRemoteAgent = Omit<
  RemoteAgent,
  "encryptedCredential" | "credentialHeader" | "credentialType"
> & {
  credentialType: RemoteAgentCredential["type"] | null;
  hasCredential: boolean;
  health: CapabilityHealth;
};

export type A2ATaskState =
  | "submitted"
  | "working"
  | "input_required"
  | "auth_required"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected"
  | "unknown";

export type A2ATask = {
  id: string;
  contextId?: string;
  state: A2ATaskState;
  statusMessage?: unknown;
  artifacts?: unknown[];
  history?: unknown[];
  metadata?: Record<string, unknown>;
  raw: Record<string, unknown>;
};

export type A2ADirectMessage = {
  kind: "message";
  message: Record<string, unknown>;
};

export type A2ASendResult = A2ATask | A2ADirectMessage;
