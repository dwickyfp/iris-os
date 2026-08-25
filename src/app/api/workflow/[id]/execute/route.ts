import { getSession } from "auth/server";
import { colorize } from "consola/utils";
import { runManager } from "lib/ai/runs/server";
import { createWorkflowExecutor } from "lib/ai/workflow/executor/workflow-executor";
import { encodeWorkflowEvent } from "lib/ai/workflow/shared.workflow";
import { workflowRepository } from "lib/db/repository";
import { safeJSONParse, toAny } from "lib/utils";
import { generateUUID } from "lib/utils";
import logger from "logger";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { query } = await request.json();
  const session = await getSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }
  const hasAccess = await workflowRepository.checkAccess(id, session.user.id);
  if (!hasAccess) {
    return new Response("Unauthorized", { status: 401 });
  }
  const workflow = await workflowRepository.selectStructureById(id, {
    ignoreNote: true,
  });
  if (!workflow) {
    return new Response("Workflow not found", { status: 404 });
  }

  const wfLogger = logger.withDefaults({
    message: colorize("cyan", `WORKFLOW '${workflow.name}' `),
  });
  const runId = generateUUID();
  const executionController = new AbortController();
  const app = createWorkflowExecutor({
    edges: workflow.edges,
    nodes: workflow.nodes,
    logger: wfLogger,
    context: {
      runId,
      userId: session.user.id,
      signal: executionController.signal,
    },
  });
  const started = await runManager.start({
    id: runId,
    userId: session.user.id,
    context: { executionSource: "workflow", workflowId: id },
    timeoutMs: 1000 * 60 * 5,
  });
  if (!started.leaseToken) throw new Error("WORKFLOW_RUN_LEASE_REQUIRED");
  const heartbeat = setInterval(
    () =>
      void runManager
        .heartbeat(runId, started.leaseToken!, 30_000)
        .then((state) => {
          if (state !== "active") executionController.abort(new Error(state));
        })
        .catch((error) => executionController.abort(error)),
    10_000,
  );
  heartbeat.unref?.();

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let isAborted = false;
      // Subscribe to workflow events
      app.subscribe((evt) => {
        if (isAborted) return;
        if (
          (evt.eventType == "NODE_START" || evt.eventType == "NODE_END") &&
          evt.node.name == "SKIP"
        ) {
          return;
        }
        try {
          const err = toAny(evt)?.error;
          if (err) {
            toAny(evt).error = {
              name: err.name || "ERROR",
              message: err?.message || safeJSONParse(err).value,
            };
          }
          // Use custom encoding instead of SSE format
          const data = encodeWorkflowEvent(evt);
          controller.enqueue(encoder.encode(data));
        } catch (error) {
          logger.error("Stream write error:", error);
          controller.error(error);
        }
      });

      // Handle client disconnection
      request.signal.addEventListener("abort", async () => {
        isAborted = true;
        executionController.abort(request.signal.reason);
        void app.exit();
        clearInterval(heartbeat);
        void runManager.cancelWithLease(
          runId,
          started.leaseToken!,
          "Workflow request aborted",
          "CANCELLED",
        );
        controller.close();
      });

      // Start the workflow
      app
        .run(
          { query },
          {
            disableHistory: true,
            timeout: 1000 * 60 * 5,
          },
        )
        .then(async (result) => {
          if (!result.isOk) {
            clearInterval(heartbeat);
            logger.error("Workflow execution error:", result.error);
            const terminal = await runManager.failWithLease(
              runId,
              started.leaseToken!,
              String(result.error),
              "WORKFLOW_FAILED",
            );
            if (!terminal) throw new Error("WORKFLOW_RUN_LEASE_LOST");
          } else {
            clearInterval(heartbeat);
            const terminal = await runManager.succeedWithLease(
              runId,
              started.leaseToken!,
              {
                workflowId: id,
              },
            );
            if (!terminal) throw new Error("WORKFLOW_RUN_LEASE_LOST");
          }
          if (!isAborted) controller.close();
        })
        .catch(async (error) => {
          clearInterval(heartbeat);
          const terminal = await runManager.failWithLease(
            runId,
            started.leaseToken!,
            error instanceof Error ? error.message : String(error),
            "WORKFLOW_FAILED",
          );
          if (
            !terminal &&
            error instanceof Error &&
            error.message !== "WORKFLOW_RUN_LEASE_LOST"
          )
            throw new Error("WORKFLOW_RUN_LEASE_LOST");
          if (!isAborted) controller.error(error);
        });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
