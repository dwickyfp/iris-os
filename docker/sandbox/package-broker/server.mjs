import { createServer } from "node:http";
import { authorizePackageRequest, packagePolicy } from "./policy.mjs";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.PORT ?? "8788", 10);
const maxBodyBytes = 16 * 1024;

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    send(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && request.url === "/v1/policy") {
    send(response, 200, packagePolicy);
    return;
  }

  if (request.method !== "POST" || request.url !== "/v1/authorize") {
    send(response, 404, { error: "not found" });
    return;
  }

  if (request.headers["content-type"] !== "application/json") {
    send(response, 415, { error: "content-type must be application/json" });
    return;
  }

  let size = 0;
  let tooLarge = false;
  const chunks = [];
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > maxBodyBytes) {
      tooLarge = true;
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    if (tooLarge) {
      send(response, 413, { error: "request body too large" });
      return;
    }

    try {
      const authorization = authorizePackageRequest(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      send(response, 200, { authorized: true, ...authorization });
    } catch {
      send(response, 400, { error: "package request denied" });
    }
  });
});

server.listen(port, host, () => {
  console.log(`package broker listening on http://${host}:${port}`);
});
