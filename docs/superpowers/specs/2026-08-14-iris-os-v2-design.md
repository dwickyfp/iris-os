# IRIS-OS V2 Design

## Objective

Evolve IRIS-OS incrementally from a chat-centric application into a learning
workspace runtime without replacing its existing chat, agent, MCP, skill,
workflow, memory, authentication, or provider systems.

## Architecture

Chat remains a streaming client of a shared execution spine. A common runtime
context carries user, workspace, thread, task, agent, correlation, tool-mode,
and approval information through chat, tools, workflows, background jobs,
automations, and delegated runs. Domain services own workspace, task, memory,
learning, activity, automation, and delegation behavior; API routes remain thin
authenticated adapters.

Context is planned in this order: current request, task state, trusted workspace
instructions, agent and skill instructions, scoped memory, relevant resources,
and conversation history. Memory and retrieved content remain untrusted data.

PgBoss remains the durable background mechanism. Activity events are persisted
before asynchronous processing; queue payloads reference event IDs and handlers
are idempotent. Existing repositories and runtimes are extended rather than
duplicated.

## Data and Compatibility

Workspaces are owner-only in V2. Legacy threads remain global with a null
workspace association. Stored thread scope is authoritative after creation.

Memory is migrated in place: `fact` becomes `semantic`, legacy records become
global, and evidence, edges, embeddings, versions, and provenance are retained.
Scope is enforced across claims, topics, entities, edges, embeddings, curation,
conflicts, and retrieval. Exact-scope graph relations prevent cross-workspace
leakage while context planning may separately include global memory.

Large subsystems are protected by server-side feature flags that default off
unless explicitly enabled. Each slice uses additive migration, backfill,
verification, controlled enablement, and eventual flag removal.

## Delivery

Deliver complete vertical slices in this order: Workspace, Scoped Memory, Task
Ledger, Activity and Learning, Learning Inbox, learned Skills, Automation,
learning-to-automation, Delegation, then the OS Dashboard. Audit, ownership,
privacy, observability, and failure behavior are acceptance gates in every
slice, not deferred cleanup.

## Non-goals

V2 does not include collaborative membership, persistent compute containers,
bulk SaaS connectors, or replacement runtimes.
