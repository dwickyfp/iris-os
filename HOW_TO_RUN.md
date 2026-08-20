# How to Run

# Start development server
pnpm dev

# Start production server (requires build first)
pnpm build:local
pnpm start

# Run Iris operations worker (learning, automation, delegation, A2A polling, parent rejoin)
# Required when IRIS_LEARNING_V2, IRIS_AUTOMATION_V2, IRIS_DELEGATION_V2, or IRIS_REMOTE_AGENTS_A2A is enabled
pnpm worker:iris

# Run memory worker (agentic memory review and consolidation)
# Required when IRIS_MEMORY_CURATOR_MODE is not "off"
pnpm worker:memory

# Apply database migrations (run once before starting app or workers)
pnpm db:migrate

# Run unit and integration tests
pnpm test

# Run disposable PostgreSQL migration and lifecycle tests (requires Docker)
pnpm test:integration:db

# Run Harness browser E2E (desktop, mobile, accessibility; requires Docker)
pnpm test:e2e:harness

# Run A2A local conformance (0.3 and 1.0 JSON-RPC profiles)
pnpm conformance:a2a

# Run disposable A2A lifecycle benchmark (requires Docker)
pnpm benchmark:a2a

# Migration rehearsal against a confirmed disposable or staging-snapshot target
pnpm migration:rehearse

# Independent read-only integrity checks
pnpm migration:integrity

# Backup, restore into a second disposable database, and verify rollback
pnpm migration:rollback-drill

# Validate sealed migration evidence against current migration set
MIGRATION_ROLLOUT_POLICY=staging pnpm migration:rollout-gate

# Lint (read-only)
pnpm lint

# Type check (read-only)
pnpm check-types

# Full Docker stack (web, PostgreSQL, iris-worker, memory-worker)
pnpm docker-compose:up

# Stop Docker stack
pnpm docker-compose:down

# Validate sandbox package policy and Compose security invariants
pnpm sandbox:check

# Build the sandbox runner, package broker, and restricted Python image
# Requires Docker. The runtime image requires gVisor on the Linux Docker host.
# Build uses a scoped non-runtime placeholder; never deploy with that value.
pnpm sandbox:build

# Pin the locally built runtime image before starting the runner
export SANDBOX_RUNNER_IMAGE="$(docker image inspect iris-sandbox-runtime:local --format '{{.Id}}')"

# Start the opt-in sandbox control plane
# Requires SANDBOX_RUNNER_TOKEN and a Docker host with runsc registered.
pnpm sandbox:up

# Run the gVisor sandbox smoke test
# On macOS/OrbStack without runsc this must remain unavailable; never fallback to runc.
pnpm sandbox:smoke

# Stop the sandbox control plane
pnpm sandbox:down

# Check health endpoints
curl http://127.0.0.1:3000/api/health/live
curl http://127.0.0.1:3000/api/health/ready

# Scrape Prometheus metrics (requires OPERATIONS_METRICS_TOKEN)
curl -H "Authorization: Bearer $OPERATIONS_METRICS_TOKEN" http://127.0.0.1:3000/api/metrics

# Minimum required environment
# POSTGRES_URL, BETTER_AUTH_SECRET, at least one provider API key
# See .env.example for all variables

# Sandbox requirements
# IRIS_SANDBOX_ENABLED=1
# IRIS_RUNNER_URL=http://sandbox-runner:8787
# IRIS_RUNNER_TOKEN=<32+ random characters>
# SANDBOX_RUNTIME_IMAGE=<immutable sandbox runtime image>
# SANDBOX_RUNNER_TOKEN=<32+ random characters>
# The sandbox feature fails closed unless Docker reports the runsc runtime.
