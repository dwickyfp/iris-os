import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { A2AProfile } from "app-types/remote-agent";

type Evidence = {
  method: string;
  version: string | undefined;
  contentType: string | undefined;
  authorization: string | undefined;
};

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startFakeA2AServer(profile: A2AProfile) {
  const evidence: Evidence[] = [];
  let baseUrl = "";
  const server = createServer(async (request, response) => {
    if (request.url === "/.well-known/agent-card.json") {
      const card =
        profile === "legacy-0.3-jsonrpc"
          ? {
              name: "IRIS deterministic A2A 0.3",
              url: `${baseUrl}/rpc`,
              protocolVersion: "0.3.0",
              capabilities: { streaming: false },
              skills: [],
            }
          : {
              name: "IRIS deterministic A2A 1.0",
              supportedInterfaces: [
                {
                  url: `${baseUrl}/rpc`,
                  protocolBinding: "JSONRPC",
                  protocolVersion: "1.0",
                },
              ],
              capabilities: { streaming: false },
              skills: [],
            };
      json(response, card);
      return;
    }
    if (request.url !== "/rpc" || request.method !== "POST") {
      json(response, { error: "not found" }, 404);
      return;
    }
    const rpc = await body(request);
    evidence.push({
      method: rpc.method,
      version: request.headers["a2a-version"] as string | undefined,
      contentType: request.headers["content-type"],
      authorization: request.headers.authorization,
    });
    const isSend = ["message/send", "SendMessage"].includes(rpc.method);
    const isCancel = ["tasks/cancel", "CancelTask"].includes(rpc.method);
    const isGet = ["tasks/get", "GetTask"].includes(rpc.method);
    let result: unknown;
    if (isSend && rpc.params.metadata?.direct === true) {
      const message = {
        role: profile === "current-1.0-jsonrpc" ? "ROLE_AGENT" : "agent",
        parts: [{ text: "deterministic direct response" }],
      };
      result = profile === "current-1.0-jsonrpc" ? { message } : message;
    } else if (isSend || isGet || isCancel) {
      const task = {
        id: "task-deterministic-1",
        contextId: "context-deterministic-1",
        status: {
          state: isCancel
            ? profile === "current-1.0-jsonrpc"
              ? "TASK_STATE_CANCELED"
              : "canceled"
            : profile === "current-1.0-jsonrpc"
              ? "TASK_STATE_COMPLETED"
              : "completed",
        },
        artifacts: [],
      };
      result = isSend && profile === "current-1.0-jsonrpc" ? { task } : task;
    } else {
      json(response, {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: "Method not found" },
      });
      return;
    }
    json(response, { jsonrpc: "2.0", id: rpc.id, result });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    endpoint: `${baseUrl}/rpc`,
    evidence,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
