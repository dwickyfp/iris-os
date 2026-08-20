export type RunBudget = {
  maxSteps?: number;
  maxTokens?: number;
  maxDurationMs?: number;
  maxToolCalls?: number;
  maxDelegations?: number;
  maxDepth?: number;
  maxParallel?: number;
  maxCost?: number;
};

export type RunUsage = {
  steps: number;
  tokens: number;
  toolCalls: number;
  delegations: number;
  depth: number;
  parallel: number;
  cost: number;
  durationMs: number;
};

export type BudgetKind = keyof RunBudget;

export class BudgetExhaustedError extends Error {
  readonly code = "BUDGET_EXHAUSTED";
  constructor(
    readonly kind: BudgetKind,
    readonly usage: RunUsage,
  ) {
    super(`Run budget exhausted: ${kind}`);
    this.name = "BudgetExhaustedError";
  }
}

const zeroUsage = (): RunUsage => ({
  steps: 0,
  tokens: 0,
  toolCalls: 0,
  delegations: 0,
  depth: 0,
  parallel: 0,
  cost: 0,
  durationMs: 0,
});

/** In-memory accounting for one run. Parent guards may be supplied for aggregate enforcement. */
export class BudgetGuard {
  readonly startedAt: number;
  private readonly current: RunUsage;
  private active = 0;

  constructor(
    readonly budget: RunBudget = {},
    private readonly parent?: BudgetGuard,
    now: () => number = Date.now,
  ) {
    this.startedAt = now();
    this.current = zeroUsage();
    this.now = now;
  }
  private readonly now: () => number;

  get usage(): RunUsage {
    return { ...this.current, durationMs: this.now() - this.startedAt };
  }

  private assert(
    kind: BudgetKind,
    amount = 1,
    usageKey: keyof RunUsage = kind as keyof RunUsage,
  ) {
    const limit = this.budget[kind];
    const value = (this.usage[usageKey] as number) + amount;
    if (limit !== undefined && value > limit)
      throw new BudgetExhaustedError(kind, this.usage);
    if (this.parent) this.parent.assert(kind, amount);
    if (
      this.budget.maxDurationMs !== undefined &&
      this.usage.durationMs >= this.budget.maxDurationMs
    )
      throw new BudgetExhaustedError("maxDurationMs", this.usage);
  }

  beforeStep() {
    this.assert("maxSteps", 1, "steps");
  }
  afterStep(input: { tokens?: number; cost?: number } = {}) {
    this.current.steps++;
    this.current.tokens += input.tokens ?? 0;
    this.current.cost += input.cost ?? 0;
    this.assert("maxTokens", 0, "tokens");
    this.assert("maxCost", 0, "cost");
  }
  beforeTool() {
    this.assert("maxToolCalls", 1, "toolCalls");
    this.assert("maxParallel", 1, "parallel");
    this.current.toolCalls++;
    this.active++;
    this.current.parallel = Math.max(this.current.parallel, this.active);
  }
  afterTool() {
    this.active = Math.max(0, this.active - 1);
  }
  beforeDelegation() {
    this.assert("maxDelegations", 1, "delegations");
    this.current.delegations++;
  }
  assertDepth(depth: number) {
    if (this.budget.maxDepth !== undefined && depth > this.budget.maxDepth)
      throw new BudgetExhaustedError("maxDepth", this.usage);
  }
  assertDuration() {
    if (
      this.budget.maxDurationMs !== undefined &&
      this.usage.durationMs >= this.budget.maxDurationMs
    )
      throw new BudgetExhaustedError("maxDurationMs", this.usage);
    this.parent?.assertDuration();
  }
  child(allocation: RunBudget, depth = 1) {
    this.beforeDelegation();
    this.assertDepth(depth);
    for (const key of Object.keys(allocation) as BudgetKind[]) {
      const requested = allocation[key];
      const remaining = this.remaining(key);
      if (
        requested !== undefined &&
        remaining !== undefined &&
        requested > remaining
      )
        throw new BudgetExhaustedError(key, this.usage);
    }
    return new BudgetGuard(allocation, this);
  }
  remaining(kind: BudgetKind) {
    const limit = this.budget[kind];
    const key =
      kind === "maxTokens"
        ? "tokens"
        : kind === "maxToolCalls"
          ? "toolCalls"
          : kind === "maxDelegations"
            ? "delegations"
            : kind === "maxParallel"
              ? "parallel"
              : kind === "maxCost"
                ? "cost"
                : kind;
    return limit === undefined
      ? undefined
      : Math.max(0, limit - (this.usage[key as keyof RunUsage] as number));
  }
}

export function isBudgetExhausted(
  error: unknown,
): error is BudgetExhaustedError {
  return (
    error instanceof BudgetExhaustedError ||
    (error instanceof Error && error.message === "BUDGET_EXHAUSTED")
  );
}
