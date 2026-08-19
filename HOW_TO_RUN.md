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

# Check health endpoints
curl http://127.0.0.1:3000/api/health/live
curl http://127.0.0.1:3000/api/health/ready

# Scrape Prometheus metrics (requires OPERATIONS_METRICS_TOKEN)
curl -H "Authorization: Bearer $OPERATIONS_METRICS_TOKEN" http://127.0.0.1:3000/api/metrics

# Minimum required environment
# POSTGRES_URL, BETTER_AUTH_SECRET, at least one provider API key
# See .env.example for all variables
