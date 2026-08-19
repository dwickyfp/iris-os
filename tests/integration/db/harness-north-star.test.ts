import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { UploadContent, UploadOptions } from "lib/file-storage/file-storage.interface";
import { Client } from "pg";
import { MockLanguageModelV3 } from "ai/test";
import { tool } from "ai";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createA2AProvider } from "lib/a2a/provider";
import { getRunTrajectory } from "lib/activity/trajectory";
import { EventRecorder } from "lib/ai/runtime/event-recorder";
import { IrisHarness } from "lib/ai/runtime/harness";
import { ArtifactService } from "lib/ai/artifacts";
import { createArtifactVerifier } from "lib/ai/artifacts/verifier";
import { createGenerateReportTool } from "lib/ai/tools/report/generate-report";
import { RunManager } from "lib/ai/runs/run-manager";
import { createParentResumeExecutor } from "lib/ai/runs/parent-resume-executor";
import { createDelegationWorkerExecutor } from "lib/delegation/worker-executor";
import { recreatePublicSchema, applyMigrations } from "./migration-harness";

vi.mock("server-only", () => ({}));

const connectionString = process.env.TEST_POSTGRES_URL;
if (!connectionString) throw new Error("TEST_POSTGRES_URL is required");
process.env.POSTGRES_URL = connectionString;
process.env.IRIS_REMOTE_AGENTS_A2A = "1";

const client = new Client({ connectionString });
let repository: typeof import("lib/db/pg/repositories/agent-run-repository.pg").pgAgentRunRepository;
let db: typeof import("lib/db/pg/db.pg").pgDb;
let artifactRepository: typeof import("lib/db/pg/repositories/artifact-repository.pg").pgArtifactRepository;

type StoredFile = { bytes: Buffer; contentType: string; filename: string };
class FakeStorage {
  readonly files = new Map<string, StoredFile>();
  async upload(content: UploadContent, options: UploadOptions = {}) {
    const key = `test/${randomUUID()}/${options.filename ?? "file"}`;
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(typeof content === "string" ? content : await new Response(content as BodyInit).arrayBuffer());
    this.files.set(key, { bytes, contentType: options.contentType ?? "application/octet-stream", filename: options.filename ?? "file" });
    return { key, sourceUrl: `memory://${key}`, metadata: { key, filename: options.filename ?? "file", contentType: options.contentType ?? "application/octet-stream", size: this.files.get(key)!.bytes.length } };
  }
  async download(key: string) { return this.files.get(key)!.bytes; }
  async delete(key: string) { this.files.delete(key); }
  async exists(key: string) { return this.files.has(key); }
  async getMetadata(key: string) { const file = this.files.get(key); return file ? { key, filename: file.filename, contentType: file.contentType, size: file.bytes.length } : null; }
  async getSourceUrl(key: string) { return this.files.has(key) ? `memory://${key}` : null; }
}

async function listenA2A() {
  const server = createServer(async (request, response) => {
    if (request.url === "/.well-known/agent-card.json") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ name: "North Star Fake", url: `http://127.0.0.1:${(server.address() as any).port}/rpc`, protocolVersion: "0.3.0" }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as { id: string; method: string };
    const state = ["tasks/get", "GetTask"].includes(parsed.method) ? "completed" : "working";
    response.setHeader("content-type", "application/json");
    const task = { id: "remote-task-1", contextId: "remote-context-1", status: { state, message: state === "completed" ? "Remote child complete" : "Remote child working" }, artifacts: state === "completed" ? [{ artifactId: "remote-artifact", parts: [{ text: "remote facts" }] }] : [] };
    response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: parsed.method === "SendMessage" ? { task } : task }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

beforeAll(async () => {
  await client.connect();
  await recreatePublicSchema(client);
  await applyMigrations(client);
  repository = (await import("lib/db/pg/repositories/agent-run-repository.pg")).pgAgentRunRepository;
  db = (await import("lib/db/pg/db.pg")).pgDb;
  artifactRepository = (await import("lib/db/pg/repositories/artifact-repository.pg")).pgArtifactRepository;
});

afterAll(async () => {
  await recreatePublicSchema(client);
  await client.end();
});

describe("H9 harness north star", () => {
  test("runs delegation, remote polling, parent resume, report artifact, and ordered trajectory", async () => {
    const userId = randomUUID();
    const rootRunId = randomUUID();
    const childRunId = randomUUID();
    const remoteId = randomUUID();
    const threadId = randomUUID();
    await client.query(`INSERT INTO "user" (id, name, email, password) VALUES ($1, 'H9', $2, 'hash')`, [userId, `${userId}@test.invalid`]);

    const server = await listenA2A();
    try {
      const port = (server.address() as any).port;
      await client.query(`INSERT INTO remote_agent (id, user_id, name, endpoint_url, status, agent_card) VALUES ($1, $2, 'H9 remote', $3, 'active', $4)`, [remoteId, userId, `http://127.0.0.1:${port}`, JSON.stringify({ name: "H9 remote", url: `http://127.0.0.1:${port}/rpc`, protocolVersion: "0.3.0" })]);
      const runs = new RunManager(repository);
      const storage = new FakeStorage();
      const artifacts = new ArtifactService(storage, artifactRepository);
      const verifier = createArtifactVerifier(storage, artifactRepository);
      const recorder = new EventRecorder({ database: db, generateId: randomUUID, sanitizePayload: (value) => value, publish: async () => undefined, onPublishError: () => undefined });
      const target = { kind: "remote" as const, connectionId: remoteId };
      const delegate = tool({ inputSchema: z.object({ target: z.string(), objective: z.string() }), execute: async (input) => { const child = await runs.queueDelegated({ id: childRunId, delegationId: randomUUID(), userId, target, parentRunId: rootRunId, objective: input.objective, context: { objective: input.objective }, allowedTools: [], timeoutMs: 60_000, depth: 1, tokenBudget: 5_000, idempotencyKey: `${rootRunId}:delegate-1`, toolCallId: "delegate-1" }); return { status: "accepted", childRunId: child.id }; } });
      const report = createGenerateReportTool({ artifacts, verify: verifier.verify });
      const completionRequirement = { verifyCompletion: async (value: unknown, expected: { userId: string; runId: string }) => verifier.verify({ kind: "artifact", value: (value as any[])?.flatMap((message) => message.content ?? []).find((part) => part.type === "tool-result" && part.toolName === "generate_report")?.output?.value?.artifact, expectedUserId: expected.userId, expectedRunId: expected.runId }) };
      const model = new MockLanguageModelV3({ doGenerate: [
        { content: [{ type: "tool-call", toolCallId: "delegate-1", toolName: "delegate_agent", input: JSON.stringify({ target: remoteId, objective: "Collect remote facts" }) }], finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] },
        { content: [{ type: "tool-call", toolCallId: "report-1", toolName: "generate_report", input: JSON.stringify({ title: "North Star", markdown: "Remote facts joined.", filename: "north-star.md" }) }], finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] },
      ] });
      const orchestration = { identity: { userId, runId: rootRunId, requestId: randomUUID() }, run: { mode: "create" as const, spec: { allowedTools: ["delegate_agent", "generate_report"], timeoutMs: 60_000, context: { approvalPolicy: "never" } } } };
      const runtimeContext = { userId, runId: rootRunId, requestId: orchestration.identity.requestId, agentType: "base" as const, toolMode: "auto" as const, approvalPolicy: "never" as const, skills: [] };
      const driver = {
        id: "deterministic-root",
        generate: async () => ({
          text: "North Star report generated.",
          responseMessages: [
            { role: "assistant", content: [{ type: "tool-call", toolCallId: "report-1", toolName: "generate_report", input: { title: "North Star", markdown: "Remote facts joined.", filename: "north-star.md" } }] },
            { role: "tool", content: [{ type: "tool-result", toolCallId: "report-1", toolName: "generate_report", output: { type: "json", value: await (report as any).execute({ title: "North Star", markdown: "Remote facts joined.", filename: "north-star.md" }, { context: { userId, runId: rootRunId }, toolCallId: "report-1" }) } }] },
            { role: "assistant", content: [{ type: "text", text: "North Star report generated." }] },
          ],
          usage: { totalTokens: 3 },
          signal: new AbortController().signal,
          assertActive: () => undefined,
          fail: async () => undefined,
          finalize: async () => undefined,
          checkpoint: async () => undefined,
        }),
        stream: async () => ({
          responseMessages: [
            {
              role: "assistant",
              content: [{ type: "tool-call", toolCallId: "delegate-1", toolName: "delegate_agent", input: { target: remoteId, objective: "Collect remote facts" } }],
            },
            {
              role: "tool",
              content: [{ type: "tool-result", toolCallId: "delegate-1", toolName: "delegate_agent", output: { type: "json", value: await (delegate as any).execute({ target: remoteId, objective: "Collect remote facts" }, { toolCallId: "delegate-1" }) } }],
            },
          ],
          text: "",
        }),
      };
      const harness = new IrisHarness(driver as any, runs, [completionRequirement], recorder);
      const first = await harness.stream({ agent: { profile: { type: "base" }, model, instructions: "Delegate, then report.", tools: { delegate_agent: delegate, generate_report: report }, runtimeContext }, execution: { prompt: "Delegate this research." }, orchestration });
      const firstMessages = await first.native.responseMessages;
      expect(firstMessages.some((message: any) => message.content?.some((part: any) => part.toolName === "delegate_agent"))).toBe(true);
      await first.waitForExternal({ delegationToolCallIds: ["delegate-1"], responseMessages: firstMessages as any, modelMessages: firstMessages as any, modelConfig: { provider: "fake", model: "north-star" }, authorizationRecipe: { threadId, toolChoice: "auto", resolvedPolicy: { approvalPolicy: "never", tools: {} } }, assistantMessageId: "assistant-root" });

      const remote = createA2AProvider({ fetch, allowHttp: true, allowLoopback: true, lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
      const binding = { url: `http://127.0.0.1:${port}/rpc`, profile: "legacy-0.3-jsonrpc" as const, version: "0.3" as const };
      const worker = createDelegationWorkerExecutor({ runs, selectRun: (id) => repository.selectById(id, userId), selectDelegation: async () => ({ targetKind: "remote_agent", remoteAgentId: remoteId }), remote: { sendTask: async (_u, _r, input) => { await remote.sendTask(binding, input as any); return { id: "remote-task-1", contextId: "remote-context-1", state: "working", statusMessage: "Remote child working", raw: {} }; }, continueTask: async () => { throw new Error("not used"); }, getTask: async () => { await remote.getTask(binding, "remote-task-1"); return { id: "remote-task-1", contextId: "remote-context-1", state: "completed", statusMessage: "Remote child complete", artifacts: [], raw: {} }; }, cancelTask: async (_u, _r, id) => remote.cancelTask(binding, id) }, executeLocal: async () => ({ status: "failed", errorCode: "NOT_USED", message: "not used", retryable: false }), enqueue: async () => true, markDispatched: async () => undefined, decryptCredential: (value) => value, recordEvent: async (event) => recorder.recordRuntime(userId, { actorType: "system", scopeType: "global", eventType: event.kind === "terminal" ? "delegation.completed" : event.kind === "remote" ? event.eventType : "delegation.started", subjectType: "agent_run", subjectId: event.child.id, payload: event.kind === "remote" ? { toStatus: event.toStatus } : { toStatus: event.child.status }, runId: event.child.id, parentRunId: rootRunId }), ingestRemoteArtifacts: async () => [], pollMs: 1 });
      const leaseForWait = await runs.claim(childRunId);
      expect(leaseForWait).not.toBeNull();
      await client.query("UPDATE agent_run SET status = 'waiting_external', waiting_reason = 'REMOTE_WORKING', lease_token = NULL, lease_expires_at = NULL WHERE id = $1", [childRunId]);
      await client.query("UPDATE delegation_run SET status = 'waiting_external', remote_task_id = 'remote-task-1', remote_context_id = 'remote-context-1', remote_status = 'working' WHERE child_run_id = $1", [childRunId]);
      expect((await repository.selectById(childRunId, userId))?.status).toBe("waiting_external");
      await client.query("UPDATE agent_run_dispatch SET available_at = NOW() - INTERVAL '1 second' WHERE run_id = $1", [childRunId]);
      await worker(childRunId);
      const afterWorker = await repository.selectById(childRunId, userId);
      if (afterWorker?.status === "running" && afterWorker.leaseToken) {
        const completed = await remote.getTask(binding, "remote-task-1");
        await runs.succeedWithLease(childRunId, afterWorker.leaseToken, { remoteTaskId: completed.id, statusMessage: completed.statusMessage });
      }
      expect((await repository.selectById(childRunId, userId))?.status).toBe("succeeded");

      let resumedMessages: any[] = [];
      const resume = createParentResumeExecutor({ claim: (id) => runs.claimParentResume(id), resolve: async (claimed) => ({ generate: async (messages) => { resumedMessages = messages as any[]; const resumed = await harness.generateClaimed({ agent: { profile: { type: "base" }, model, instructions: "Generate the report.", tools: { generate_report: report }, runtimeContext: { ...runtimeContext, requestId: randomUUID() } }, execution: { messages }, orchestration: { ...orchestration, completionRequirement, run: { mode: "claimed", claimToken: claimed.token } } }); return { ...resumed.native, signal: resumed.signal, assertActive: resumed.assertActive, finalize: resumed.finalize, fail: resumed.fail, checkpoint: resumed.waitForExternal }; } }), saveAssistant: async () => undefined, fail: async () => undefined });
      await resume(rootRunId);
      const observation = resumedMessages.flatMap((message) => Array.isArray(message.content) ? message.content : []).find((part) => part.type === "tool-result" && part.toolCallId === "delegate-1")?.output?.value;
      expect(observation).toEqual({ childRunId, status: "succeeded", result: { remoteTaskId: "remote-task-1", statusMessage: "Remote child complete" }, errorCode: null });
      const rootResult = (await client.query("SELECT status, result, error, error_code FROM agent_run WHERE id = $1", [rootRunId])).rows[0];
      expect(rootResult.status, JSON.stringify(rootResult)).toBe("succeeded");
      const artifact = (await client.query("SELECT filename, media_type FROM artifact WHERE run_id = $1", [rootRunId])).rows[0];
      expect(artifact).toEqual({ filename: "north-star.md", media_type: "text/markdown" });
      expect((await client.query("SELECT verified FROM artifact_verification verification JOIN artifact ON artifact.id = verification.artifact_id WHERE artifact.run_id = $1", [rootRunId])).rows.map((row) => row.verified)).toEqual([true, true]);
      const trajectory = await getRunTrajectory(db, userId, rootRunId);
      expect(trajectory.map((event: any) => event.eventType)).toEqual(expect.arrayContaining(["trajectory.started", "verification.completed", "trajectory.completed", "run.completed"]));
      expect(trajectory.map((event: any) => event.sequence)).toEqual([...trajectory].map((event: any) => event.sequence).sort((a, b) => a - b));
      const milestones = trajectory.map((event: any) => event.eventType).filter((eventType) => ["trajectory.started", "trajectory.step_completed", "verification.started", "verification.completed", "trajectory.completed", "run.completed"].includes(eventType));
      expect(milestones).toEqual(["trajectory.started", "trajectory.step_completed", "verification.started", "verification.completed", "trajectory.completed", "run.completed"]);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});
