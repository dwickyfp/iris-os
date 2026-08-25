import type { DurableJob, DurableJobOutcome } from "./contracts";

export const CAPABILITY_ORCHESTRATION_JOB_TYPE =
  "capability-orchestration" as const;

export type DurableJobTargetHandler = (
  job: DurableJob,
  context?: { signal?: AbortSignal },
) => Promise<DurableJobOutcome>;

export function assertAllowedDurableJobTarget(
  target: DurableJob["target"],
): asserts target is { kind: "job"; jobType: "capability-orchestration" } {
  if (
    target.kind !== "job" ||
    target.jobType !== CAPABILITY_ORCHESTRATION_JOB_TYPE
  ) {
    throw new Error("DURABLE_JOB_TARGET_NOT_ALLOWED");
  }
}

export class DurableJobTargetRegistry {
  private readonly handlers = new Map<string, DurableJobTargetHandler>();

  register(jobType: string, handler: DurableJobTargetHandler) {
    if (jobType !== CAPABILITY_ORCHESTRATION_JOB_TYPE) {
      throw new Error(`DURABLE_JOB_TARGET_NOT_ALLOWED:${jobType}`);
    }
    if (this.handlers.has(jobType)) {
      throw new Error(`DURABLE_JOB_TARGET_ALREADY_REGISTERED:${jobType}`);
    }
    this.handlers.set(jobType, handler);
    return this;
  }

  async execute(job: DurableJob, context?: { signal?: AbortSignal }) {
    assertAllowedDurableJobTarget(job.target);
    const handler = this.handlers.get(job.target.jobType);
    if (!handler) throw new Error("DURABLE_JOB_TARGET_NOT_REGISTERED");
    return handler(job, context);
  }
}
