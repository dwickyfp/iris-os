CREATE TABLE "root_run_budget" (
  "root_run_id" uuid PRIMARY KEY NOT NULL REFERENCES "agent_run"("id") ON DELETE CASCADE,
  "max_steps" integer NOT NULL,
  "max_tokens" integer NOT NULL,
  "max_duration_ms" integer NOT NULL,
  "max_tool_calls" integer NOT NULL,
  "max_delegations" integer NOT NULL,
  "max_delegation_depth" integer NOT NULL,
  "max_parallel_children" integer NOT NULL,
  "max_sandbox_compute_ms" integer NOT NULL,
  "committed_steps" integer NOT NULL DEFAULT 0,
  "committed_tokens" integer NOT NULL DEFAULT 0,
  "committed_tool_calls" integer NOT NULL DEFAULT 0,
  "committed_delegations" integer NOT NULL DEFAULT 0,
  "committed_children" integer NOT NULL DEFAULT 0,
  "committed_sandbox_compute_ms" integer NOT NULL DEFAULT 0,
  "reserved_steps" integer NOT NULL DEFAULT 0,
  "reserved_tokens" integer NOT NULL DEFAULT 0,
  "reserved_tool_calls" integer NOT NULL DEFAULT 0,
  "reserved_delegations" integer NOT NULL DEFAULT 0,
  "reserved_children" integer NOT NULL DEFAULT 0,
  "reserved_sandbox_compute_ms" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "root_run_budget_limits_check" CHECK (
    "max_steps" > 0 AND "max_tokens" > 0 AND "max_duration_ms" > 0
    AND "max_tool_calls" >= 0 AND "max_delegations" >= 0
    AND "max_delegation_depth" >= 0 AND "max_parallel_children" >= 0
    AND "max_sandbox_compute_ms" >= 0
  ),
  CONSTRAINT "root_run_budget_usage_check" CHECK (
    "committed_steps" >= 0 AND "committed_tokens" >= 0
    AND "committed_tool_calls" >= 0 AND "committed_delegations" >= 0
    AND "committed_children" >= 0 AND "committed_sandbox_compute_ms" >= 0
    AND "reserved_steps" >= 0 AND "reserved_tokens" >= 0
    AND "reserved_tool_calls" >= 0 AND "reserved_delegations" >= 0
    AND "reserved_children" >= 0 AND "reserved_sandbox_compute_ms" >= 0
    AND "committed_steps" + "reserved_steps" <= "max_steps"
    AND "committed_tokens" + "reserved_tokens" <= "max_tokens"
    AND "committed_tool_calls" + "reserved_tool_calls" <= "max_tool_calls"
    AND "committed_delegations" + "reserved_delegations" <= "max_delegations"
    AND "reserved_children" <= "max_parallel_children"
    AND "committed_sandbox_compute_ms" + "reserved_sandbox_compute_ms" <= "max_sandbox_compute_ms"
  )
);
--> statement-breakpoint
CREATE TABLE "root_run_budget_reservation" (
  "token" varchar(240) PRIMARY KEY NOT NULL,
  "root_run_id" uuid NOT NULL REFERENCES "root_run_budget"("root_run_id") ON DELETE CASCADE,
  "run_id" uuid NOT NULL REFERENCES "agent_run"("id") ON DELETE CASCADE,
  "kind" varchar(40) NOT NULL,
  "amount" integer NOT NULL,
  "state" varchar(20) NOT NULL DEFAULT 'reserved',
  "committed_amount" integer,
  "expires_at" timestamp NOT NULL,
  "settled_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "root_run_budget_reservation_kind_check" CHECK ("kind" IN ('steps','tokens','tool_calls','delegations','children','sandbox_compute_ms')),
  CONSTRAINT "root_run_budget_reservation_state_check" CHECK ("state" IN ('reserved','committed','released')),
  CONSTRAINT "root_run_budget_reservation_amount_check" CHECK (
    "amount" > 0 AND ("committed_amount" IS NULL OR "committed_amount" BETWEEN 0 AND "amount")
    AND (("state" = 'reserved' AND "settled_at" IS NULL) OR ("state" <> 'reserved' AND "settled_at" IS NOT NULL))
  )
);
--> statement-breakpoint
CREATE INDEX "root_run_budget_reservation_stale_idx"
  ON "root_run_budget_reservation" ("root_run_id", "expires_at")
  WHERE "state" = 'reserved';
--> statement-breakpoint
INSERT INTO "root_run_budget" (
  "root_run_id", "max_steps", "max_tokens", "max_duration_ms",
  "max_tool_calls", "max_delegations", "max_delegation_depth",
  "max_parallel_children", "max_sandbox_compute_ms",
  "committed_sandbox_compute_ms", "reserved_sandbox_compute_ms"
)
SELECT root.id, 10, root.token_budget, root.timeout_ms, 32, 8, 3, 8,
       GREATEST(300000, COALESCE(compute.committed_ms, 0) + COALESCE(compute.reserved_ms, 0)),
       COALESCE(compute.committed_ms, 0), COALESCE(compute.reserved_ms, 0)
FROM "agent_run" root
LEFT JOIN (
  SELECT run.root_run_id,
         COALESCE(SUM(b.committed_compute_ms), 0)::integer AS committed_ms,
         COALESCE(SUM(b.reserved_compute_ms), 0)::integer AS reserved_ms
  FROM "sandbox_run_compute_budget" b
  JOIN "agent_run" run ON run.id = b.run_id
  GROUP BY run.root_run_id
) compute ON compute.root_run_id = root.id
WHERE root.id = root.root_run_id
ON CONFLICT ("root_run_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "root_run_budget_reservation" (
  "token", "root_run_id", "run_id", "kind", "amount", "state",
  "expires_at", "created_at"
)
SELECT 'sandbox:' || execution.reservation_token::text,
       run.root_run_id,
       execution.run_id,
       'sandbox_compute_ms',
       execution.reserved_compute_ms,
       'reserved',
       CASE
         WHEN execution.started_at IS NOT NULL
           THEN COALESCE(execution.settlement_deadline_at,
                         execution.reservation_expires_at)
         ELSE execution.reservation_expires_at
       END,
       COALESCE(execution.started_at, execution.reservation_expires_at,
                CURRENT_TIMESTAMP)
FROM "sandbox_execution" execution
JOIN "agent_run" run ON run.id = execution.run_id
WHERE execution.charged_at IS NULL
  AND (
    execution.status IN ('reserved', 'running')
    OR (execution.started_at IS NOT NULL
        AND execution.status NOT IN ('reserved', 'running'))
  )
ON CONFLICT ("token") DO NOTHING;
--> statement-breakpoint
UPDATE "sandbox_run_compute_budget" budget
SET "reserved_compute_ms" = ledger.reserved_ms,
    "max_compute_ms" = CASE
      WHEN budget.max_compute_ms IS NULL THEN NULL
      ELSE GREATEST(
        budget.max_compute_ms,
        budget.committed_compute_ms + ledger.reserved_ms
      )
    END,
    "updated_at" = CURRENT_TIMESTAMP
FROM (
  SELECT budget_run.run_id,
         COALESCE(SUM(reservation.amount) FILTER (
           WHERE reservation.kind = 'sandbox_compute_ms'
             AND reservation.state = 'reserved'
         ), 0)::integer AS reserved_ms
  FROM "sandbox_run_compute_budget" budget_run
  LEFT JOIN "root_run_budget_reservation" reservation
    ON reservation.run_id = budget_run.run_id
  GROUP BY budget_run.run_id
) ledger
WHERE budget.run_id = ledger.run_id;
--> statement-breakpoint
UPDATE "root_run_budget" budget
SET "reserved_sandbox_compute_ms" = ledger.reserved_ms,
    "max_sandbox_compute_ms" = GREATEST(
      budget.max_sandbox_compute_ms,
      budget.committed_sandbox_compute_ms + ledger.reserved_ms
    ),
    "updated_at" = CURRENT_TIMESTAMP
FROM (
  SELECT root.root_run_id,
         COALESCE(SUM(reservation.amount) FILTER (
           WHERE reservation.kind = 'sandbox_compute_ms'
             AND reservation.state = 'reserved'
         ), 0)::integer AS reserved_ms
  FROM "root_run_budget" root
  LEFT JOIN "root_run_budget_reservation" reservation
    ON reservation.root_run_id = root.root_run_id
  GROUP BY root.root_run_id
) ledger
WHERE budget.root_run_id = ledger.root_run_id;
