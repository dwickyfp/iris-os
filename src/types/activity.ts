import { z } from "zod";
import { MemoryScopeTypeSchema } from "./memory";

export const ActivityActorTypeSchema = z.enum(["user", "agent", "system"]);

const JsonPayloadSchema = z.object({}).catchall(z.unknown());
const ChatPayloadSchema = JsonPayloadSchema.extend({
  userMessageId: z.string().max(200).optional(),
  assistantMessageId: z.string().max(200).optional(),
  model: z.string().max(240).optional(),
  userText: z.string().max(2_000).optional(),
  errorCode: z.string().max(120).optional(),
});
const StatePayloadSchema = JsonPayloadSchema.extend({
  fromStatus: z.string().max(80).optional(),
  toStatus: z.string().max(80).optional(),
  errorCode: z.string().max(120).optional(),
  message: z.string().max(2_000).optional(),
});
const RunPayloadSchema = StatePayloadSchema.extend({
  targetType: z.enum(["workflow", "skill", "agent", "remote_agent"]).optional(),
  attempt: z.number().int().min(0).optional(),
  retryable: z.boolean().optional(),
});
const ArtifactVerificationPayloadSchema = StatePayloadSchema.extend({
  artifactId: z.string().uuid(),
  verified: z.boolean().optional(),
  reason: z.string().max(120).optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const ContextPreparationPayloadSchema = JsonPayloadSchema.extend({
  compacted: z.boolean(),
  estimatedTokensBefore: z.number().int().min(0),
  estimatedTokensAfter: z.number().int().min(0),
  sourceCount: z.number().int().min(0),
});
const CompletionVerificationPayloadSchema = StatePayloadSchema.extend({
  verified: z.boolean(),
  reason: z.string().max(240).optional(),
  requirementCount: z.number().int().min(0),
});
const RoutingPayloadSchema = JsonPayloadSchema.extend({
  driver: z.string().max(120).optional(),
  provider: z.string().max(120).optional(),
  model: z.string().max(240).optional(),
});
const ModelPayloadSchema = StatePayloadSchema.extend({
  stepNumber: z.number().int().min(0).optional(),
  finishReason: z.string().max(120).optional(),
  totalTokens: z.number().int().min(0).optional(),
});

export const ActivityEventPayloadRegistry = {
  "run.started": RunPayloadSchema,
  "run.completed": RunPayloadSchema,
  "run.failed": RunPayloadSchema,
  "run.cancelled": RunPayloadSchema,
  "routing.resolved": RoutingPayloadSchema,
  "model.requested": ModelPayloadSchema,
  "model.completed": ModelPayloadSchema,
  "model.failed": ModelPayloadSchema,
  "chat.started": ChatPayloadSchema,
  "chat.completed": ChatPayloadSchema,
  "chat.failed": ChatPayloadSchema,
  "chat.cancelled": ChatPayloadSchema,
  "chat.correction": ChatPayloadSchema,
  "tool.requested": StatePayloadSchema,
  "tool.approval_requested": StatePayloadSchema,
  "tool.approved": StatePayloadSchema,
  "tool.rejected": StatePayloadSchema,
  "tool.started": StatePayloadSchema,
  "tool.completed": StatePayloadSchema,
  "tool.failed": StatePayloadSchema,
  "tool.cancelled": StatePayloadSchema,
  "workflow.started": RunPayloadSchema,
  "workflow.node_completed": RunPayloadSchema,
  "workflow.node_failed": RunPayloadSchema,
  "workflow.completed": RunPayloadSchema,
  "workflow.cancelled": RunPayloadSchema,
  "task.created": StatePayloadSchema,
  "task.assigned": StatePayloadSchema,
  "task.status_changed": StatePayloadSchema,
  "task.checkpointed": StatePayloadSchema,
  "task.continued": StatePayloadSchema,
  "task.completed": StatePayloadSchema,
  "skill.created": StatePayloadSchema,
  "skill.executed": RunPayloadSchema,
  "skill.corrected": StatePayloadSchema,
  "skill.version_proposed": StatePayloadSchema,
  "skill.version_approved": StatePayloadSchema,
  "skill.version_rejected": StatePayloadSchema,
  "learning.observation_created": StatePayloadSchema,
  "learning.candidate_created": StatePayloadSchema,
  "learning.candidate_reviewed": StatePayloadSchema,
  "learning.suppressed": StatePayloadSchema,
  "learning.promoted": StatePayloadSchema,
  "learning.promotion_started": StatePayloadSchema,
  "learning.promotion_failed": StatePayloadSchema,
  "learning.skill_activated": StatePayloadSchema,
  "learning.skill_deactivated": StatePayloadSchema,
  "automation.triggered": RunPayloadSchema,
  "automation.approval_blocked": RunPayloadSchema,
  "automation.started": RunPayloadSchema,
  "automation.retried": RunPayloadSchema,
  "automation.completed": RunPayloadSchema,
  "automation.failed": RunPayloadSchema,
  "automation.cancelled": RunPayloadSchema,
  "automation.missed": RunPayloadSchema,
  "delegation.requested": RunPayloadSchema,
  "delegation.child_queued": RunPayloadSchema,
  "delegation.started": RunPayloadSchema,
  "delegation.completed": RunPayloadSchema,
  "delegation.failed": RunPayloadSchema,
  "delegation.cancelled": RunPayloadSchema,
  "delegation.timed_out": RunPayloadSchema,
  "agent.remote_task_created": RunPayloadSchema,
  "agent.remote_status_changed": RunPayloadSchema,
  "agent.remote_artifact_received": RunPayloadSchema,
  "agent.remote_artifact_verified": RunPayloadSchema,
  "agent.input_required": RunPayloadSchema,
  "agent.auth_required": RunPayloadSchema,
  "trajectory.started": RunPayloadSchema,
  "trajectory.step_completed": RunPayloadSchema,
  "trajectory.completed": RunPayloadSchema,
  "trajectory.failed": RunPayloadSchema,
  "trajectory.cancelled": RunPayloadSchema,
  "context.prepared": ContextPreparationPayloadSchema,
  "verification.started": CompletionVerificationPayloadSchema,
  "verification.completed": CompletionVerificationPayloadSchema,
  "verification.failed": CompletionVerificationPayloadSchema,
  "artifact.created": StatePayloadSchema,
  "artifact.verification_started": ArtifactVerificationPayloadSchema,
  "artifact.verification_completed": ArtifactVerificationPayloadSchema,
  "artifact.verification_failed": ArtifactVerificationPayloadSchema,
  "artifact.archived": StatePayloadSchema,
  "resource.created": StatePayloadSchema,
  "resource.attached": StatePayloadSchema,
  "resource.detached": StatePayloadSchema,
  "resource.archived": StatePayloadSchema,
} as const;

export type ActivityEventType = keyof typeof ActivityEventPayloadRegistry;
export const ActivityEventTypeSchema = z.enum(
  Object.keys(ActivityEventPayloadRegistry) as [
    ActivityEventType,
    ...ActivityEventType[],
  ],
);

const ActivityEventBaseSchema = z.object({
  id: z.string().uuid().optional(),
  schemaVersion: z.number().int().min(1).max(20).default(1),
  actorType: ActivityActorTypeSchema,
  actorId: z.string().max(160).optional(),
  scopeType: MemoryScopeTypeSchema.default("global"),
  scopeId: z.string().uuid().nullable().optional(),
  eventType: ActivityEventTypeSchema,
  subjectType: z.string().trim().min(1).max(80),
  subjectId: z.string().trim().max(200).optional(),
  payload: JsonPayloadSchema.default({}),
  requestId: z.string().max(160).optional(),
  runId: z.string().max(160).optional(),
  parentRunId: z.string().max(160).optional(),
  threadId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  occurrenceId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(1).max(240),
});

export const ActivityEventInputSchema = ActivityEventBaseSchema.superRefine(
  (event, context) => {
    if (event.scopeType === "global" && event.scopeId) {
      context.addIssue({
        code: "custom",
        message: "Global scope cannot have an id",
      });
    }
    if (event.scopeType !== "global" && !event.scopeId) {
      context.addIssue({
        code: "custom",
        message: "Scoped event requires scopeId",
      });
    }
    const payload = ActivityEventPayloadRegistry[event.eventType].safeParse(
      event.payload,
    );
    if (!payload.success) {
      for (const issue of payload.error.issues) {
        context.addIssue({ ...issue, path: ["payload", ...issue.path] });
      }
    }
  },
);

export type ActivityEventInput = z.input<typeof ActivityEventInputSchema>;
export type ParsedActivityEventInput = z.output<
  typeof ActivityEventInputSchema
>;
