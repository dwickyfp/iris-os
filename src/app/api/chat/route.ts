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
  buildBaseAgentSystemPrompt,
  buildMcpServerCustomizationsSystemPrompt,
  buildToolCallUnsupportedModelSystemPrompt,
  buildUserSystemPrompt,
} from "lib/ai/prompts";
import {
  agentRepository,
  agentRunRepository,
  chatRepository,
  taskRepository,
  workspaceRepository,
} from "lib/db/repository";
import globalLogger from "logger";

import { safe } from "ts-safe";

import { buildCsvIngestionPreviewParts } from "@/lib/ai/ingest/csv-ingest";
import { getSession } from "auth/server";
import { colorize } from "consola/utils";
import { recordActivityEvent } from "lib/activity/service";
import { isReadOnlyTool } from "lib/ai/agent/approval-policy";
import {
  createAgentRuntimeContext,
  createBaseAgentRuntimeContext,
} from "lib/ai/agent/runtime-context";
import { createGoalVerificationRequirement } from "lib/ai/artifacts/default-verification.server";
import { enqueueMemoryReview } from "lib/ai/memory/queue";
import { buildMemoryContext, indexChatMessage } from "lib/ai/memory/service";
import type { HarnessStreamResult } from "lib/ai/runtime";
import { isBudgetExhausted } from "lib/ai/runtime/budget";
import {
  buildServerCapabilityResolutionInput,
  resolveServerCapabilities,
} from "lib/ai/runtime/capabilities/server";
import type { NormalizedGoalRequirement } from "lib/ai/runtime/goal-requirement-resolver";
import { policyEngine } from "lib/ai/runtime/policy-engine";
import type { RunPreparationSnapshot } from "lib/ai/runtime/run-preparer";
import { irisHarness } from "lib/ai/runtime/server";
import { createProductionRunAdapter } from "lib/ai/runtime/server-run-adapters";
import { buildSkillManifestPrompt } from "lib/ai/skill";
import { ImageToolName } from "lib/ai/tools";
import {
  MANAGE_AUTOMATION_TOOL_NAME,
  createManageAutomationTool,
} from "lib/ai/tools/background/manage-automation";
import {
  MANAGE_LEARNING_TOOL_NAME,
  createManageLearningTool,
} from "lib/ai/tools/background/manage-learning";
import { nanoBananaTool, openaiImageTool } from "lib/ai/tools/image";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { serverFileStorage } from "lib/file-storage";
import { isChatCorrection } from "lib/learning/policy";
import { sandboxManager } from "lib/sandbox/server";
import { buildTaskContextPrompt } from "lib/task/context";
import { generateUUID } from "lib/utils";
import {
  buildWorkspaceInstructionsPrompt,
  resolveThreadWorkspaceId,
} from "lib/workspace/context";
import { workspaceService } from "lib/workspace/server";
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
      primaryAgentId,
      autonomy,
      capabilityHints,
      attachments = [],
      workspaceId: requestedWorkspaceId,
      taskId: requestedTaskId,
    } = chatApiSchemaRequestBodySchema.parse(json);
    const requestId = generateUUID();
    const runId = generateUUID();
    let checkpointResolvedPolicy;

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

    const agentId =
      primaryAgentId ??
      (
        mentions.find((m) => m.type === "agent") as Extract<
          ChatMention,
          { type: "agent" }
        >
      )?.agentId;

    const agent = await rememberAgentAction(agentId, session.user.id);

    const useImageTool =
      supportToolCall && Boolean(imageTool?.model) && toolChoice !== "none";

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

    let harnessStream: HarnessStreamResult<any> | undefined;
    let checkpointModelMessages: unknown[] = [];
    let checkpointPreparationSnapshot: RunPreparationSnapshot = {};
    let checkpointGoalRequirement: NormalizedGoalRequirement | undefined;
    let streamError: unknown;
    const stream = createUIMessageStream({
      execute: async ({ writer: dataStream }) => {
        const userText = message.parts
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
          .join(" ");
        const BACKGROUND_CONTROL_TOOLS: Record<string, Tool> = {
          ...(isV2FeatureEnabled("learning")
            ? {
                [MANAGE_LEARNING_TOOL_NAME]: createManageLearningTool({
                  userId: session.user.id,
                  userText,
                }),
              }
            : {}),
          ...(isV2FeatureEnabled("automation")
            ? {
                [MANAGE_AUTOMATION_TOOL_NAME]: createManageAutomationTool({
                  userId: session.user.id,
                  userText,
                }),
              }
            : {}),
        };
        const capabilityInput = await buildServerCapabilityResolutionInput({
          userId: session.user.id,
          workspaceId: workspace?.id,
          taskId: task?.id,
          runId,
          goal: userText,
          agent,
          permissions: { allowedMcpServers, allowedAppDefaultToolkit },
          featureState: {
            tools: isToolCallAllowed,
            workflows: isToolCallAllowed,
            delegation: isToolCallAllowed && isV2FeatureEnabled("delegation"),
            remoteAgents: isV2FeatureEnabled("remoteAgents"),
            learning: isV2FeatureEnabled("learning"),
          },
          hints: {
            mode: useImageTool ? "only" : capabilityHints.mode,
            requested: useImageTool
              ? [
                  {
                    type: "defaultTool",
                    name: ImageToolName,
                    label: "Generate image",
                  },
                ]
              : mentions.filter(
                  (
                    mention,
                  ): mention is Exclude<ChatMention, { type: "agent" }> =>
                    mention.type !== "agent",
                ),
          },
          additionalTools: {
            ...(isToolCallAllowed ? BACKGROUND_CONTROL_TOOLS : {}),
            ...(useImageTool
              ? {
                  [ImageToolName]:
                    imageTool?.model === "google"
                      ? nanoBananaTool
                      : openaiImageTool,
                }
              : {}),
          },
          workflowBinding: { dataStream },
        });
        const approvalPolicy = policyEngine.approvalPolicyForMode(autonomy);
        const preparationAdapter = createProductionRunAdapter(
          { surface: "chat", approvalPolicy },
          {
            resolveCapabilities: async () => {
              const value = await resolveServerCapabilities(capabilityInput);
              return {
                value,
                tools: value.model,
                descriptors: value.ordered,
                selectedCapabilities: value.ordered,
                routing: {
                  descriptorIds: value.ordered.map(({ id }) => id),
                  eligibleDelegationTargets: value.eligibleDelegationTargets,
                  diagnostics: value.routing,
                },
              };
            },
            resolveRuntimeContext: async ({ policy, capabilities: value }) =>
              agent
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
                    approvalPolicy: policy.approvalPolicy,
                    skills: value.skillManifest,
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
                    approvalPolicy: policy.approvalPolicy,
                  }),
            resolveModel: async () => ({
              value: model,
              descriptor: {
                provider: modelConfig.provider,
                model: modelConfig.model,
                contextWindow: modelConfig.contextWindow,
              },
            }),
          },
        );
        const preparationCapabilities =
          await preparationAdapter.resolveCapabilities(undefined);
        const capabilities = preparationCapabilities.value;
        const MCP_TOOLS = Object.fromEntries(
          capabilities.ordered
            .filter(({ kind }) => kind === "mcp")
            .map(({ key, value }) => [key, value]),
        ) as Record<string, any>;
        const inProgressToolParts = extractInProgressToolPart(message);
        if (inProgressToolParts.length) {
          await Promise.all(
            inProgressToolParts.map(async (part) => {
              const output = await manualToolExecuteByLastMessage(
                part,
                capabilities.manual as Record<string, Tool>,
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
          userText,
          {
            agentId: agent?.id,
            workspaceId: workspace?.id,
            taskId: task?.id,
          },
        );
        const assembledInstructions = mergeSystemPrompt(
          !agent && buildBaseAgentSystemPrompt(),
          !supportToolCall && buildToolCallUnsupportedModelSystemPrompt,
        );

        const manualMode =
          toolChoice === "manual" ||
          (message.metadata as ChatMetadata)?.toolChoice === "manual";
        const manuallyConfirmedKinds = new Set(["mcp", "workflow"]);
        const routedModelTools = Object.fromEntries(
          capabilities.ordered
            .filter(({ key }) => Object.hasOwn(capabilities.model, key))
            .map(({ key, kind }) => [
              key,
              manualMode && manuallyConfirmedKinds.has(kind)
                ? excludeToolExecution({
                    [key]: capabilities.model[key] as Tool,
                  })[key]
                : capabilities.model[key],
            ]),
        );
        if (capabilities.model.delegate_agent)
          routedModelTools.delegate_agent = capabilities.model.delegate_agent;
        const vercelAITooles = routedModelTools as Record<string, Tool>;
        metadata.toolCount = Object.keys(vercelAITooles).length;
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
            `binding tool count: ${Object.keys(vercelAITooles).length}, MCP: ${Object.keys(MCP_TOOLS).length}`,
          );
        }
        logger.info(`model: ${chatModel?.provider}/${chatModel?.model}`);

        preparationCapabilities.tools = vercelAITooles;
        const preparedRun = await preparationAdapter.prepare({
          capabilities: preparationCapabilities,
          request: {
            requestedBudget: { maxTokens: 50_000 },
            userId: session.user.id,
            workspaceId: workspace?.id,
            agentId: agent?.id,
            threadId: thread!.id,
            instructions: assembledInstructions,
            request: userText,
            goal: userText,
            sources: [
              {
                id: "agent-and-skills",
                kind: "agent",
                content: [
                  agent?.instructions,
                  buildSkillManifestPrompt(capabilities.skillManifest),
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                trust: "trusted",
                priority: 90,
              },
              {
                id: "workspace",
                kind: "workspace",
                content: workspace
                  ? buildWorkspaceInstructionsPrompt(workspace)
                  : "",
                trust: "trusted",
                priority: 80,
              },
              {
                id: "task",
                kind: "task",
                content: buildTaskContextPrompt(task),
                trust: "trusted",
                priority: 70,
              },
              {
                id: "memory",
                kind: "memory",
                content: memoryContext.prompt,
                trust: "mixed",
                priority: 60,
              },
              {
                id: "mcp-customization",
                kind: "mcp",
                content: buildMcpServerCustomizationsSystemPrompt(
                  mcpServerCustomizations,
                ),
                trust: "mixed",
                priority: 50,
              },
              {
                id: "user-preferences",
                kind: "user_preferences",
                content: buildUserSystemPrompt(
                  session.user,
                  userPreferences,
                  agent,
                ),
                trust: "trusted",
                priority: 40,
              },
            ],
            messages,
            contextWindow: modelConfig.contextWindow,
          },
        });
        const preparedContext = preparedRun.context;
        const modelMessages = await convertToModelMessages(
          preparedRun.messages,
        );
        checkpointModelMessages = modelMessages;
        checkpointPreparationSnapshot = preparedRun.snapshot;
        checkpointGoalRequirement = preparedRun.goalRequirement;
        const resolvedPolicy = preparedRun.policy!;
        checkpointResolvedPolicy = resolvedPolicy;
        const runtimeContext = preparedRun.runtimeContext!;
        harnessStream = await irisHarness.stream({
          agent: {
            profile: agent ? { type: "custom", agent } : { type: "base" },
            model,
            instructions: preparedContext.instructions,
            tools: vercelAITooles,
            runtimeContext,
            resolvedPolicy,
          },
          execution: {
            messages: modelMessages,
            runtimeContext,
            toolsContext: runtimeContext,
            abortSignal: request.signal,
            experimental_transform: smoothStream({ chunking: "word" }),
          } as any,
          orchestration: {
            identity: {
              userId: session.user.id,
              runId,
              requestId,
              actorType: agent ? "agent" : "system",
              actorId: agent?.id,
              agentId: agent?.id,
              workspaceId: workspace?.id,
              taskId: task?.id,
              threadId: thread!.id,
            },
            run: {
              mode: "create",
              spec: {
                context: {
                  userMessageId: message.id,
                  approvedDelegationTools:
                    Object.keys(vercelAITooles).filter(isReadOnlyTool),
                  eligibleDelegationTargets:
                    capabilities.eligibleDelegationTargets,
                  capabilityDescriptorIds: capabilities.ordered.map(
                    ({ id }) => id,
                  ),
                  policyAuthority: resolvedPolicy.authority,
                  approvalPolicy,
                  systemPrompt: preparedContext.instructions,
                  goalRequirement: preparedRun.goalRequirement,
                },
                allowedTools: Object.keys(vercelAITooles),
                budget: preparedRun.budget,
              },
            },
            context: preparedContext,
            policy: resolvedPolicy,
            budget: preparedRun.budget,
            routing: {
              descriptorIds: capabilities.ordered.map(({ id }) => id),
              diagnostics: capabilities.routing,
              model: preparedRun.snapshot.model as Record<string, unknown>,
              driver: { driver: "ai-sdk" },
            },
            completionRequirement:
              preparedRun.completionRequirement ??
              createGoalVerificationRequirement(preparedRun.goalRequirement),
          },
        });
        const result = harnessStream.native;
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
        const responseMessages = harnessStream
          ? await harnessStream.native.responseMessages
          : [];
        const { successfulDelegationToolCallIds } = await import(
          "lib/ai/runs/parent-resume-executor"
        );
        const delegationToolCallIds = successfulDelegationToolCallIds(
          responseMessages as any,
        );
        const delegated = delegationToolCallIds.length > 0;
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
        if (!isAborted && finishReason !== "error")
          void enqueueMemoryReview({
            id: `${thread!.id}:${responseMessage.id}`,
            userId: session.user.id,
            threadId: thread!.id,
            workspaceId: workspace?.id,
            taskId: task?.id,
            assistantMessageId: responseMessage.id,
            userMessageId: message.id,
            agentId: agent?.id,
          }).catch((error) =>
            logger.warn("Unable to enqueue memory review", error),
          );
        const completedUserText = message.parts
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
          .join(" ")
          .slice(0, 2_000);
        const chatEventType = delegated
          ? "chat.completed"
          : isAborted
            ? "chat.cancelled"
            : finishReason === "error"
              ? "chat.failed"
              : isChatCorrection(completedUserText)
                ? "chat.correction"
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
            userText: completedUserText,
          },
          requestId,
          runId,
          threadId: thread!.id,
          taskId: task?.id,
          agentId: agent?.id,
          idempotencyKey: `${chatEventType}:${responseMessage.id}`,
        }).catch((error) => logger.warn("Unable to record activity", error));
        if (delegated) {
          const run = await agentRunRepository.selectById(
            runId,
            session.user.id,
          );
          await harnessStream?.waitForExternal({
            goalRequirement: checkpointGoalRequirement,
            delegationToolCallIds,
            responseMessages,
            modelMessages: [...checkpointModelMessages, ...responseMessages],
            modelConfig: {
              provider: modelConfig.provider,
              model: modelConfig.model,
            },
            authorizationRecipe: {
              userId: session.user.id,
              threadId: thread!.id,
              workspaceId: workspace?.id,
              taskId: task?.id,
              agentId: agent?.id,
              instructions: run?.context.systemPrompt,
              toolChoice,
              autonomy,
              resolvedPolicy: checkpointResolvedPolicy,
              allowedMcpServers,
              allowedAppDefaultToolkit,
              capabilityHints,
              descriptorIds: run?.context.capabilityDescriptorIds ?? [],
              eligibleDelegationTargets:
                run?.context.eligibleDelegationTargets ?? [],
              routingSnapshot: checkpointPreparationSnapshot.routing,
              budgetSnapshot: checkpointPreparationSnapshot.budget,
              completionSnapshot: checkpointPreparationSnapshot.completion,
              contextSnapshot: checkpointPreparationSnapshot.context,
              modelSnapshot: checkpointPreparationSnapshot.model,
              driverSnapshot: checkpointPreparationSnapshot.driver,
            },
            assistantMessageId: responseMessage.id,
          });
        } else if (isAborted)
          await harnessStream?.fail({
            error: "Chat stream was aborted",
            errorCode: "ABORTED",
            status: "cancelled",
          });
        else if (finishReason === "error")
          await harnessStream?.fail({
            error: streamError ?? "Chat stream finished with an error",
            errorCode: isBudgetExhausted(streamError)
              ? "BUDGET_EXHAUSTED"
              : "STREAM_ERROR",
          });
        else
          await harnessStream?.finalize(responseMessage, {
            assistantMessageId: responseMessage.id,
          });
        if (!delegated)
          await sandboxManager.cancelByRun(runId).catch(() => undefined);
      },
      onError: (error) => {
        streamError = error;
        const errorMessage = handleError(error);
        const errorCode = isBudgetExhausted(error)
          ? "BUDGET_EXHAUSTED"
          : "STREAM_ERROR";
        void sandboxManager.cancelByRun(runId).catch(() => undefined);
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
            errorCode,
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
        void harnessStream?.fail({
          error,
          errorCode,
        });
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
