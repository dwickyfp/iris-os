import { getSession } from "auth/server";
import { createWorkflowExecutor } from "lib/ai/workflow/executor/workflow-executor";
import { workflowRepository } from "lib/db/repository";
import { encodeWorkflowEvent } from "lib/ai/workflow/shared.workflow";
import logger from "logger";
import { colorize } from "consola/utils";
import { safeJSONParse, toAny } from "lib/utils";
import { generateUUID } from "lib/utils";
import { sandboxManager, workflowSandboxServices } from "lib/sandbox/server";
import { runManager } from "lib/ai/runs/server";

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
  const workflow = await workflowRepository.selectStructureById(id);
  if (!workflow) {
    return new Response("Workflow not found", { status: 404 });
  }

  const wfLogger = logger.withDefaults({
    message: colorize("cyan", `WORKFLOW '${workflow.name}' `),
  });
  const runId = generateUUID();
  await runManager.start({
    id: runId,
    userId: session.user.id,
    context: { executionSource: "workflow", workflowId: id },
    timeoutMs: 1000 * 60 * 5,
  });
  const app = createWorkflowExecutor({
    edges: workflow.edges,
    nodes: workflow.nodes,
    logger: wfLogger,
    context: {
      runId,
      userId: session.user.id,
      signal: request.signal,
      services: workflowSandboxServices(runId),
    },
  });

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
          // Close stream when workflow ends
          if (evt.eventType === "WORKFLOW_END") {
            controller.close();
          }
        } catch (error) {
          logger.error("Stream write error:", error);
          controller.error(error);
        }
      });

      // Handle client disconnection
      request.signal.addEventListener("abort", async () => {
        isAborted = true;
        void app.exit();
        void runManager.cancel(runId, "Workflow request aborted", "CANCELLED");
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
        .then((result) => {
          if (!result.isOk) {
            logger.error("Workflow execution error:", result.error);
            void runManager.fail(runId, String(result.error), "WORKFLOW_FAILED");
          } else {
            void runManager.succeed(runId, { workflowId: id });
          }
        })
        .finally(() => {
          void sandboxManager.cancelByRun(runId).catch(() => undefined);
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
