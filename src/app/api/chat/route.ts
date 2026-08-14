import {
  Tool,
  UIMessage,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  smoothStream,
} from "ai";

import { customModelProvider } from "lib/ai/models";

import {
  ChatMention,
  ChatMetadata,
  chatApiSchemaRequestBodySchema,
} from "app-types/chat";
import {
  buildMcpServerCustomizationsSystemPrompt,
  buildBaseAgentSystemPrompt,
  buildToolCallUnsupportedModelSystemPrompt,
  buildUserSystemPrompt,
} from "lib/ai/prompts";
import {
  agentRepository,
  chatRepository,
  skillRepository,
  taskRepository,
  workspaceRepository,
} from "lib/db/repository";
import globalLogger from "logger";

import { errorIf, safe } from "ts-safe";

import { buildCsvIngestionPreviewParts } from "@/lib/ai/ingest/csv-ingest";
import { getSession } from "auth/server";
import { colorize } from "consola/utils";
import { createToolLoopAgent } from "lib/ai/agent/create-tool-loop-agent";
import {
  createAgentRuntimeContext,
  createBaseAgentRuntimeContext,
} from "lib/ai/agent/runtime-context";
import { compactContext } from "lib/ai/context-compaction";
import {
  type AssignedSkillsRepository,
  bindSkillTools,
  buildSkillManifestPrompt,
  createSkillsRuntime,
} from "lib/ai/skill";
import { ImageToolName } from "lib/ai/tools";
import { nanoBananaTool, openaiImageTool } from "lib/ai/tools/image";
import { serverFileStorage } from "lib/file-storage";
import { generateUUID } from "lib/utils";
import { buildMemoryContext, indexChatMessage } from "lib/ai/memory/service";
import { enqueueMemoryReview } from "lib/ai/memory/queue";
import { isV2FeatureEnabled } from "lib/feature-flags";
import {
  buildWorkspaceInstructionsPrompt,
  resolveThreadWorkspaceId,
} from "lib/workspace/context";
import { workspaceService } from "lib/workspace/server";
import { buildTaskContextPrompt } from "lib/task/context";
import { recordActivityEvent } from "lib/activity/service";
import { pgDb } from "lib/db/pg/db.pg";
import { AgentRunTable } from "lib/db/pg/schema.pg";
import { and, eq } from "drizzle-orm";
import { isReadOnlyTool } from "lib/ai/agent/approval-policy";
import {
  createDelegateWorkTool,
  DELEGATE_WORK_TOOL_NAME,
} from "lib/ai/tools/delegation/delegate-work";
import {
  rememberAgentAction,
  rememberMcpServerCustomizationsAction,
} from "./actions";
import {
  convertToSavePart,
  excludeToolExecution,
  extractInProgressToolPart,
  filterMcpServerCustomizations,
  handleError,
  loadAppDefaultTools,
  loadMcpTools,
  loadWorkFlowTools,
  manualToolExecuteByLastMessage,
  mergeSystemPrompt,
} from "./shared.chat";

const logger = globalLogger.withDefaults({
  message: colorize("blackBright", `Chat API: `),
});

export async function POST(request: Request) {
  try {
    const json = await request.json();

    const session = await getSession();

    if (!session?.user.id) {
      return new Response("Unauthorized", { status: 401 });
    }
    const {
      id,
      message,
      chatModel,
      toolChoice,
      allowedAppDefaultToolkit,
      allowedMcpServers,
      imageTool,
      mentions = [],
      attachments = [],
      workspaceId: requestedWorkspaceId,
      taskId: requestedTaskId,
    } = chatApiSchemaRequestBodySchema.parse(json);
    const requestId = generateUUID();
    const runId = generateUUID();

    const modelConfig =
      await customModelProvider.getModelConfiguration(chatModel);
    const model = await customModelProvider.getModel(chatModel);

    if (
      attachments.some((attachment) =>
        attachment.mediaType?.startsWith("image/"),
      ) &&
      !modelConfig.capabilities.vision
    ) {
      return new Response("The selected model does not support image input", {
        status: 400,
      });
    }

    let thread = await chatRepository.selectThreadDetails(id);
    const threadExists = Boolean(thread);
    const resolvedWorkspaceId = resolveThreadWorkspaceId({
      threadExists,
      storedWorkspaceId: thread?.workspaceId,
      requestedWorkspaceId: isV2FeatureEnabled("workspaces")
        ? requestedWorkspaceId
        : undefined,
    });

    const requestedTask = requestedTaskId
      ? await taskRepository.select(requestedTaskId, session.user.id)
      : null;
    if (requestedTaskId && !requestedTask)
      return Response.json({ error: "Task not found" }, { status: 404 });
    if (requestedTask && requestedTask.workspaceId !== resolvedWorkspaceId) {
      return Response.json(
        { error: "Task and workspace scopes do not match" },
        { status: 409 },
      );
    }
    if (!thread) {
      if (resolvedWorkspaceId)
        await workspaceService.resolveRequestedWorkspace(
          session.user.id,
          resolvedWorkspaceId,
        );
      logger.info(`create chat thread: ${id}`);
      const newThread = await chatRepository.insertThread({
        id,
        title: "",
        userId: session.user.id,
        workspaceId: resolvedWorkspaceId,
        taskId: requestedTask?.id,
      });
      thread = await chatRepository.selectThreadDetails(newThread.id);
    }

    if (thread!.userId !== session.user.id) {
      return new Response("Forbidden", { status: 403 });
    }
    const workspace =
      isV2FeatureEnabled("workspaces") && thread?.workspaceId
        ? await workspaceRepository.selectById(
            thread.workspaceId,
            session.user.id,
          )
        : null;
    const task = thread?.taskId
      ? await taskRepository.select(thread.taskId, session.user.id)
      : null;

    const messages: UIMessage[] = (thread?.messages ?? []).map((m) => {
      return {
        id: m.id,
        role: m.role,
        parts: m.parts,
        metadata: m.metadata,
      };
    });

    if (messages.at(-1)?.id == message.id) {
      messages.pop();
    }
    const ingestionPreviewParts = await buildCsvIngestionPreviewParts(
      attachments,
      (key) => serverFileStorage.download(key),
    );
    if (ingestionPreviewParts.length) {
      const baseParts = [...message.parts];
      let insertionIndex = -1;
      for (let i = baseParts.length - 1; i >= 0; i -= 1) {
        if (baseParts[i]?.type === "text") {
          insertionIndex = i;
          break;
        }
      }
      if (insertionIndex !== -1) {
        baseParts.splice(insertionIndex, 0, ...ingestionPreviewParts);
        message.parts = baseParts;
      } else {
        message.parts = [...baseParts, ...ingestionPreviewParts];
      }
    }

    if (attachments.length) {
      const firstTextIndex = message.parts.findIndex(
        (part: any) => part?.type === "text",
      );
      const attachmentParts: any[] = [];

      attachments.forEach((attachment) => {
        const exists = message.parts.some(
          (part: any) =>
            part?.type === attachment.type && part?.url === attachment.url,
        );
        if (exists) return;

        if (attachment.type === "file") {
          attachmentParts.push({
            type: "file",
            url: attachment.url,
            mediaType: attachment.mediaType,
            filename: attachment.filename,
          });
        } else if (attachment.type === "source-url") {
          attachmentParts.push({
            type: "source-url",
            url: attachment.url,
            mediaType: attachment.mediaType,
            title: attachment.filename,
          });
        }
      });

      if (attachmentParts.length) {
        if (firstTextIndex >= 0) {
          message.parts = [
            ...message.parts.slice(0, firstTextIndex),
            ...attachmentParts,
            ...message.parts.slice(firstTextIndex),
          ];
        } else {
          message.parts = [...message.parts, ...attachmentParts];
        }
      }
    }

    messages.push(message);

    // Persist the incoming message before starting the streamed response. A browser
    // reload, network abort, or dev HMR must not discard a message the user sent.
    await chatRepository.upsertMessage({
      threadId: thread!.id,
      id: message.id,
      role: message.role,
      parts: message.parts.map(convertToSavePart),
    });

    const supportToolCall = modelConfig.capabilities.toolCalls;

    const agentId = (
      mentions.find((m) => m.type === "agent") as Extract<
        ChatMention,
        { type: "agent" }
      >
    )?.agentId;

    const agent = await rememberAgentAction(agentId, session.user.id);

    if (agent?.instructions?.mentions) {
      mentions.push(...agent.instructions.mentions);
    }

    const useImageTool = Boolean(imageTool?.model) && toolChoice !== "none";

    const isToolCallAllowed =
      supportToolCall && toolChoice !== "none" && !useImageTool;

    const metadata: ChatMetadata = {
      agentType: agent ? "custom" : "base",
      agentId: agent?.id,
      toolChoice: toolChoice,
      toolCount: 0,
      chatModel: chatModel,
    };

    void recordActivityEvent(session.user.id, {
      actorType: "user",
      scopeType: task
        ? "task"
        : workspace
          ? "workspace"
          : agent
            ? "agent"
            : "global",
      scopeId: task?.id ?? workspace?.id ?? agent?.id ?? null,
      eventType: "chat.started",
      subjectType: "thread",
      subjectId: thread!.id,
      payload: { userMessageId: message.id, model: chatModel },
      requestId,
      runId,
      threadId: thread!.id,
      taskId: task?.id,
      agentId: agent?.id,
      idempotencyKey: `chat.started:${message.id}`,
    }).catch((error) => logger.warn("Unable to record activity", error));

    const stream = createUIMessageStream({
      execute: async ({ writer: dataStream }) => {
        const MCP_TOOLS = await safe()
          .map(errorIf(() => !isToolCallAllowed && "Not allowed"))
          .map(() =>
            loadMcpTools({
              mentions,
              allowedMcpServers,
            }),
          )
          .orElse({});

        const WORKFLOW_TOOLS = await safe()
          .map(errorIf(() => !isToolCallAllowed && "Not allowed"))
          .map(() =>
            loadWorkFlowTools({
              mentions,
              dataStream,
            }),
          )
          .orElse({});

        const APP_DEFAULT_TOOLS = await safe()
          .map(errorIf(() => !isToolCallAllowed && "Not allowed"))
          .map(() =>
            loadAppDefaultTools({
              mentions,
              allowedAppDefaultToolkit,
            }),
          )
          .orElse({});
        const skillsRuntime =
          agent && supportToolCall
            ? await createSkillsRuntime({
                repository: skillRepository as AssignedSkillsRepository,
                agentId: agent.id,
                userId: session.user.id,
              })
            : { manifest: [], tools: {} };
        const inProgressToolParts = extractInProgressToolPart(message);
        if (inProgressToolParts.length) {
          await Promise.all(
            inProgressToolParts.map(async (part) => {
              const output = await manualToolExecuteByLastMessage(
                part,
                bindSkillTools(
                  {
                    ...MCP_TOOLS,
                    ...WORKFLOW_TOOLS,
                    ...APP_DEFAULT_TOOLS,
                  },
                  skillsRuntime.tools,
                ),
                request.signal,
              );
              part.output = output;

              dataStream.write({
                type: "tool-output-available",
                toolCallId: part.toolCallId,
                output,
              });
            }),
          );
        }

        const userPreferences = thread?.userPreferences || undefined;

        const mcpServerCustomizations = await safe()
          .map(() => {
            if (Object.keys(MCP_TOOLS ?? {}).length === 0)
              throw new Error("No tools found");
            return rememberMcpServerCustomizationsAction(session.user.id);
          })
          .map((v) => filterMcpServerCustomizations(MCP_TOOLS!, v))
          .orElse({});

        const memoryContext = await buildMemoryContext(
          session.user.id,
          message.parts
            .filter((part: any) => part.type === "text")
            .map((part: any) => part.text)
            .join(" "),
          {
            agentId: agent?.id,
            workspaceId: workspace?.id,
            taskId: task?.id,
          },
        );
        const systemPrompt = mergeSystemPrompt(
          !agent && buildBaseAgentSystemPrompt(),
          buildUserSystemPrompt(session.user, userPreferences, agent),
          buildMcpServerCustomizationsSystemPrompt(mcpServerCustomizations),
          buildSkillManifestPrompt(skillsRuntime.manifest),
          workspace ? buildWorkspaceInstructionsPrompt(workspace) : "",
          buildTaskContextPrompt(task),
          memoryContext.prompt,
          !supportToolCall && buildToolCallUnsupportedModelSystemPrompt,
        );

        const IMAGE_TOOL: Record<string, Tool> = useImageTool
          ? {
              [ImageToolName]:
                imageTool?.model === "google"
                  ? nanoBananaTool
                  : openaiImageTool,
            }
          : {};
        const DELEGATION_TOOLS: Record<string, Tool> = isV2FeatureEnabled(
          "delegation",
        )
          ? {
              [DELEGATE_WORK_TOOL_NAME]: createDelegateWorkTool({
                parentRunId: runId,
                userId: session.user.id,
              }),
            }
          : {};
        const vercelAITooles = safe({
          ...MCP_TOOLS,
          ...WORKFLOW_TOOLS,
        })
          .map((t) => {
            const bindingTools =
              toolChoice === "manual" ||
              (message.metadata as ChatMetadata)?.toolChoice === "manual"
                ? excludeToolExecution(t)
                : t;
            return bindSkillTools(
              {
                ...bindingTools,
                ...APP_DEFAULT_TOOLS, // APP_DEFAULT_TOOLS Not Supported Manual
                ...IMAGE_TOOL,
                ...DELEGATION_TOOLS,
              },
              skillsRuntime.tools,
            );
          })
          .unwrap();
        metadata.toolCount = Object.keys(vercelAITooles).length;
        if (isV2FeatureEnabled("delegation")) {
          await pgDb
            .insert(AgentRunTable)
            .values({
              id: runId,
              userId: session.user.id,
              agentId: agent?.id,
              workspaceId: workspace?.id,
              taskId: task?.id,
              status: "running",
              context: {
                requestId,
                threadId: thread!.id,
                userMessageId: message.id,
                approvedDelegationTools:
                  Object.keys(vercelAITooles).filter(isReadOnlyTool),
              },
              allowedTools: Object.keys(vercelAITooles),
              startedAt: new Date(),
            })
            .onConflictDoNothing();
        }

        const allowedMcpTools = Object.values(allowedMcpServers ?? {})
          .map((t) => t.tools)
          .flat();

        logger.info(
          `${agent ? `agent: ${agent.name}, ` : ""}tool mode: ${toolChoice}, mentions: ${mentions.length}`,
        );

        logger.info(
          `allowedMcpTools: ${allowedMcpTools.length ?? 0}, allowedAppDefaultToolkit: ${allowedAppDefaultToolkit?.length ?? 0}`,
        );
        if (useImageTool) {
          logger.info(`binding tool count Image: ${imageTool?.model}`);
        } else {
          logger.info(
            `binding tool count APP_DEFAULT: ${Object.keys(APP_DEFAULT_TOOLS ?? {}).length}, MCP: ${Object.keys(MCP_TOOLS ?? {}).length}, Workflow: ${Object.keys(WORKFLOW_TOOLS ?? {}).length}`,
          );
        }
        logger.info(`model: ${chatModel?.provider}/${chatModel?.model}`);

        const compactedMessages = await compactContext({
          threadId: thread!.id,
          messages,
          contextWindow: modelConfig.contextWindow,
          model,
        });
        const modelMessages = await convertToModelMessages(compactedMessages);
        const runtimeContext = agent
          ? createAgentRuntimeContext({
              requestId,
              runId,
              userId: session.user.id,
              workspaceId: workspace?.id,
              taskId: task?.id,
              threadId: thread!.id,
              agent,
              userRole: (session.user as any).role,
              toolMode: toolChoice,
              approvalPolicy:
                toolChoice === "manual" ? "always" : "destructive_only",
              skills: skillsRuntime.manifest,
            })
          : createBaseAgentRuntimeContext({
              requestId,
              runId,
              userId: session.user.id,
              workspaceId: workspace?.id,
              taskId: task?.id,
              threadId: thread!.id,
              userRole: (session.user as any).role,
              toolMode: toolChoice,
              approvalPolicy:
                toolChoice === "manual" ? "always" : "destructive_only",
            });
        const result = await createToolLoopAgent({
          profile: agent ? { type: "custom", agent } : { type: "base" },
          model,
          instructions: systemPrompt,
          tools: vercelAITooles,
          runtimeContext,
        }).stream({
          messages: modelMessages,
          runtimeContext,
          toolsContext: runtimeContext,
          abortSignal: request.signal,
          experimental_transform: smoothStream({ chunking: "word" }),
        } as any);
        result.consumeStream();
        dataStream.merge(
          result.toUIMessageStream({
            messageMetadata: ({ part }) => {
              if (part.type == "finish") {
                metadata.usage = part.totalUsage;
                return metadata;
              }
            },
          }),
        );
      },

      generateId: generateUUID,
      onEnd: async ({ responseMessage, isAborted, finishReason }) => {
        if (responseMessage.id == message.id) {
          await chatRepository.upsertMessage({
            threadId: thread!.id,
            id: responseMessage.id,
            role: responseMessage.role,
            parts: responseMessage.parts.map(convertToSavePart),
            metadata,
          });
        } else {
          await chatRepository.upsertMessage({
            threadId: thread!.id,
            role: message.role,
            parts: message.parts.map(convertToSavePart),
            id: message.id,
          });
          await chatRepository.upsertMessage({
            threadId: thread!.id,
            role: responseMessage.role,
            id: responseMessage.id,
            parts: responseMessage.parts.map(convertToSavePart),
            metadata,
          });
        }

        if (agent) {
          agentRepository.updateAgent(agent.id, session.user.id, {
            updatedAt: new Date(),
          } as any);
        }
        await Promise.all([
          indexChatMessage({
            userId: session.user.id,
            threadId: thread!.id,
            message,
          }),
          indexChatMessage({
            userId: session.user.id,
            threadId: thread!.id,
            message: responseMessage,
          }),
        ]);
        void enqueueMemoryReview({
          id: `${thread!.id}:${responseMessage.id}`,
          userId: session.user.id,
          threadId: thread!.id,
          workspaceId: workspace?.id,
          assistantMessageId: responseMessage.id,
          userMessageId: message.id,
          agentId: agent?.id,
          userText: message.parts
            .filter((part: any) => part.type === "text")
            .map((part: any) => part.text)
            .join(" ")
            .slice(0, 8_000),
          assistantText: responseMessage.parts
            .filter((part: any) => part.type === "text")
            .map((part: any) => part.text)
            .join(" ")
            .slice(0, 8_000),
          chatModel,
        }).catch((error) =>
          logger.warn("Unable to enqueue memory review", error),
        );
        const chatEventType = isAborted
          ? "chat.cancelled"
          : finishReason === "error"
            ? "chat.failed"
            : "chat.completed";
        void recordActivityEvent(session.user.id, {
          actorType: agent ? "agent" : "system",
          actorId: agent?.id,
          scopeType: task
            ? "task"
            : workspace
              ? "workspace"
              : agent
                ? "agent"
                : "global",
          scopeId: task?.id ?? workspace?.id ?? agent?.id ?? null,
          eventType: chatEventType,
          subjectType: "thread",
          subjectId: thread!.id,
          payload: {
            userMessageId: message.id,
            assistantMessageId: responseMessage.id,
            model: chatModel,
            userText: message.parts
              .filter((part: any) => part.type === "text")
              .map((part: any) => part.text)
              .join(" ")
              .slice(0, 8_000),
          },
          requestId,
          runId,
          threadId: thread!.id,
          taskId: task?.id,
          agentId: agent?.id,
          idempotencyKey: `${chatEventType}:${responseMessage.id}`,
        }).catch((error) => logger.warn("Unable to record activity", error));
        if (isV2FeatureEnabled("delegation")) {
          const runStatus = isAborted
            ? "cancelled"
            : finishReason === "error"
              ? "failed"
              : "succeeded";
          void pgDb
            .update(AgentRunTable)
            .set({
              status: runStatus,
              result:
                runStatus === "succeeded"
                  ? { assistantMessageId: responseMessage.id }
                  : null,
              error:
                runStatus === "failed"
                  ? "Chat stream finished with an error"
                  : null,
              completedAt: new Date(),
            })
            .where(
              and(
                eq(AgentRunTable.id, runId),
                eq(AgentRunTable.status, "running"),
              ),
            );
        }
      },
      onError: (error) => {
        const errorMessage = handleError(error);
        void recordActivityEvent(session.user.id, {
          actorType: agent ? "agent" : "system",
          actorId: agent?.id,
          scopeType: task
            ? "task"
            : workspace
              ? "workspace"
              : agent
                ? "agent"
                : "global",
          scopeId: task?.id ?? workspace?.id ?? agent?.id ?? null,
          eventType: "chat.failed",
          subjectType: "thread",
          subjectId: thread!.id,
          payload: {
            userMessageId: message.id,
            errorCode: "STREAM_ERROR",
            message: errorMessage,
          },
          requestId,
          runId,
          threadId: thread!.id,
          taskId: task?.id,
          agentId: agent?.id,
          idempotencyKey: `chat.failed:${runId}`,
        }).catch((activityError) =>
          logger.warn("Unable to record activity", activityError),
        );
        if (isV2FeatureEnabled("delegation")) {
          void pgDb
            .update(AgentRunTable)
            .set({
              status: "failed",
              error: errorMessage.slice(0, 2_000),
              completedAt: new Date(),
            })
            .where(
              and(
                eq(AgentRunTable.id, runId),
                eq(AgentRunTable.status, "running"),
              ),
            );
        }
        return errorMessage;
      },
      originalMessages: messages,
    });

    return createUIMessageStreamResponse({
      stream,
    });
  } catch (error: any) {
    logger.error(error);
    return Response.json({ message: error.message }, { status: 500 });
  }
}
