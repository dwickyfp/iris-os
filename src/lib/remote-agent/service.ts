import type {
  A2ABinding,
  A2ASendResult,
  AgentCard,
  PublicRemoteAgent,
  RemoteAgent,
  RemoteAgentCreateInput,
  RemoteAgentUpdateInput,
} from "app-types/remote-agent";
import {
  A2ATaskSendSchema,
  RemoteAgentCreateSchema,
  RemoteAgentUpdateSchema,
} from "app-types/remote-agent";
import { type A2AProvider, selectA2ABinding } from "lib/a2a/provider";
import { validatePublicUrl } from "lib/security/outbound-http";
import {
  decryptRemoteAgentSecret,
  encryptRemoteAgentSecret,
} from "lib/security/secrets";
import { remoteAgentHealth } from "./health";

type InsertRemoteAgent = Omit<
  RemoteAgent,
  "id" | "userId" | "createdAt" | "updatedAt"
>;

type UpdateRemoteAgent = Partial<
  Omit<RemoteAgent, "id" | "userId" | "createdAt" | "updatedAt">
>;

export type RemoteAgentRepository = {
  listByUserId(userId: string): Promise<RemoteAgent[]>;
  selectById(id: string, userId: string): Promise<RemoteAgent | null>;
  insert(userId: string, input: InsertRemoteAgent): Promise<RemoteAgent>;
  update(
    id: string,
    userId: string,
    input: UpdateRemoteAgent,
  ): Promise<RemoteAgent | null>;
  delete(id: string, userId: string): Promise<boolean>;
};

function publicAgent(agent: RemoteAgent): PublicRemoteAgent {
  const { encryptedCredential, credentialHeader: _header, ...safe } = agent;
  return {
    ...safe,
    hasCredential: Boolean(encryptedCredential),
    health: remoteAgentHealth(agent),
  };
}

function requireAgent(agent: RemoteAgent | null) {
  if (!agent) throw new Error("Remote agent not found");
  return agent;
}

function credentialFor(agent: RemoteAgent) {
  if (!agent.credentialType || !agent.encryptedCredential) return undefined;
  const value = decryptRemoteAgentSecret(agent.encryptedCredential);
  return agent.credentialType === "bearer"
    ? ({ type: "bearer", value } as const)
    : ({
        type: "api_key",
        value,
        headerName: agent.credentialHeader ?? "X-API-Key",
      } as const);
}

function rpcBinding(agent: RemoteAgent): A2ABinding {
  if (!agent.agentCard) throw new Error("Remote agent has not been discovered");
  return selectA2ABinding(agent.agentCard);
}

export function createRemoteAgentService(
  repository: RemoteAgentRepository,
  provider: A2AProvider,
  validateUrl: typeof validatePublicUrl = validatePublicUrl,
) {
  async function ownedActiveAgent(userId: string, id: string) {
    const agent = requireAgent(await repository.selectById(id, userId));
    if (agent.status !== "active") throw new Error("Remote agent is disabled");
    return agent;
  }

  async function ownedAgent(userId: string, id: string) {
    return requireAgent(await repository.selectById(id, userId));
  }

  async function discoverAgent(
    endpointUrl: string,
    credential?: Parameters<A2AProvider["discover"]>[1],
  ): Promise<AgentCard> {
    await validateUrl(endpointUrl);
    const card = await provider.discover(endpointUrl, credential);
    const binding = selectA2ABinding(card);
    await validateUrl(binding.url);
    if (
      credential &&
      new URL(binding.url).origin !== new URL(endpointUrl).origin
    ) {
      throw new Error(
        "Agent Card must not redirect configured credentials to another origin",
      );
    }
    return card;
  }

  return {
    async list(userId: string) {
      return (await repository.listByUserId(userId)).map(publicAgent);
    },

    async get(userId: string, id: string) {
      return publicAgent(requireAgent(await repository.selectById(id, userId)));
    },

    async create(userId: string, input: RemoteAgentCreateInput) {
      const data = RemoteAgentCreateSchema.parse(input);
      const card = await discoverAgent(data.endpointUrl, data.credential);
      const now = new Date();
      return publicAgent(
        await repository.insert(userId, {
          name: data.name,
          endpointUrl: data.endpointUrl,
          status: data.status,
          credentialType: data.credential?.type ?? null,
          credentialHeader:
            data.credential?.type === "api_key"
              ? data.credential.headerName
              : null,
          encryptedCredential: data.credential
            ? encryptRemoteAgentSecret(data.credential.value)
            : null,
          agentCard: card,
          discoveredAt: now,
        }),
      );
    },

    async update(userId: string, id: string, input: RemoteAgentUpdateInput) {
      const current = requireAgent(await repository.selectById(id, userId));
      const data = RemoteAgentUpdateSchema.parse(input);
      const update: UpdateRemoteAgent = {};
      if (data.name !== undefined) update.name = data.name;
      if (data.status !== undefined) update.status = data.status;
      if (data.endpointUrl !== undefined) update.endpointUrl = data.endpointUrl;
      if (data.credential !== undefined) {
        update.credentialType = data.credential?.type ?? null;
        update.credentialHeader =
          data.credential?.type === "api_key"
            ? data.credential.headerName
            : null;
        update.encryptedCredential = data.credential
          ? encryptRemoteAgentSecret(data.credential.value)
          : null;
      }
      if (data.endpointUrl !== undefined || data.credential !== undefined) {
        const candidate = { ...current, ...update };
        update.agentCard = await discoverAgent(
          candidate.endpointUrl,
          credentialFor(candidate),
        );
        update.discoveredAt = new Date();
      }
      return publicAgent(
        requireAgent(await repository.update(id, userId, update)),
      );
    },

    async delete(userId: string, id: string) {
      if (!(await repository.delete(id, userId))) {
        throw new Error("Remote agent not found");
      }
    },

    async discover(userId: string, id: string) {
      const agent = await ownedActiveAgent(userId, id);
      const card = await discoverAgent(agent.endpointUrl, credentialFor(agent));
      return publicAgent(
        requireAgent(
          await repository.update(id, userId, {
            agentCard: card,
            discoveredAt: new Date(),
          }),
        ),
      );
    },

    async sendTask(
      userId: string,
      id: string,
      input: unknown,
      options?: {
        requestId?: string;
        credential?: Parameters<A2AProvider["sendTask"]>[2];
      },
    ): Promise<A2ASendResult> {
      const agent = await ownedActiveAgent(userId, id);
      const args = [
        rpcBinding(agent),
        A2ATaskSendSchema.parse(input),
        options?.credential ?? credentialFor(agent),
      ] as const;
      return options?.requestId
        ? provider.sendTask(...args, options.requestId)
        : provider.sendTask(...args);
    },

    async getTask(
      userId: string,
      id: string,
      taskId: string,
      credential?: Parameters<A2AProvider["getTask"]>[2],
    ) {
      const agent = await ownedAgent(userId, id);
      return provider.getTask(
        rpcBinding(agent),
        taskId,
        credential ?? credentialFor(agent),
      );
    },

    async cancelTask(
      userId: string,
      id: string,
      taskId: string,
      credential?: Parameters<A2AProvider["cancelTask"]>[2],
    ) {
      const agent = await ownedAgent(userId, id);
      return provider.cancelTask(
        rpcBinding(agent),
        taskId,
        credential ?? credentialFor(agent),
      );
    },

    async continueTask(
      userId: string,
      id: string,
      input: unknown,
      options: {
        requestId: string;
        credential?: Parameters<A2AProvider["sendTask"]>[2];
      },
    ) {
      const agent = await ownedAgent(userId, id);
      return provider.sendTask(
        rpcBinding(agent),
        A2ATaskSendSchema.parse(input),
        options.credential ?? credentialFor(agent),
        options.requestId,
      );
    },
  };
}
