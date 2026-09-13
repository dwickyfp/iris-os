# Repository Decisions

Record durable architectural or product decisions. Each entry should include date,
context, decision, consequences, and superseded decision when applicable.

## 2026-08-14 — IRIS-OS V2 delivery and scope

- **Context:** The approved V2 specification spans workspace, memory, tasks,
  learning, automation, delegation, and dashboard behavior.
- **Decision:** Deliver V2 as verified vertical slices on existing runtimes.
  Legacy chats remain global, initial workspaces are owner-only, stored thread
  scope is authoritative, and memory scope applies to the complete graph.
- **Consequences:** Workspace and scoped memory must land before tasks and
  learning. Large subsystems use additive migrations and server-side flags.
  Collaboration and replacement runtimes remain out of scope.

## 2026-09-12 — Agent file operations via scoped virtual filesystem, no sandbox

- **Context:** Agents need persistent file operations, which motivated a
  sandbox proposal (gVisor). The Docker/gVisor compute sandbox was fully
  retired (695a064); gVisor is Linux-only (dev host is macOS), adds syscall
  overhead, and rebuilding it in-house repeats the retired operational
  surface. Most agent file needs (read/write/edit/search) do not execute
  code, so kernel isolation is not the required boundary.
- **Decision:** Provide file operations through a server-side virtual
  filesystem tool (`workspace_fs`) whose tool API is the security boundary:
  UTF-8 text content only, paths jailed per user+scope, size/count quotas,
  optimistic concurrency. Bounded content is stored inline in Postgres
  (`workspace_file`); large/binary content remains with the artifact
  subsystem. A code-execution sandbox, if ever needed, must be a swappable
  executor behind one narrow tool, not a rebuilt platform.
- **Consequences:** No sandbox infra is reintroduced; agents gain persistent
  scoped workspaces (task > workspace > global precedence) but cannot execute
  code server-side. Future executor work must not resurrect the retired
  session/budget/reaper subsystem.

## 2026-09-13 — Remote agent connections merged into the Agents page

- **Context:** Remote agents (A2A connections) had a dedicated `/remote-agents`
  page plus a sidebar entry, but they are conceptually part of the agent
  surface, not a separate destination.
- **Decision:** Move remote agent connection management into `/agents` as a
  "Remote agents" section (feature-flag gated on
  `IRIS_REMOTE_AGENTS_A2A`). The top-right "Create Agent" control is a
  dropdown offering "Built-in agent" (→ `/agent/new`) and "Remote agent"
  (opens the connection form). The `/remote-agents` route, its page, and the
  sidebar entry were removed; `RemoteAgentConnections` was refactored into
  `RemoteAgentsSection` with a controlled `createOpen` prop so the dropdown
  can open the form directly. Harness e2e tests now target `/agents`.
- **Consequences:** One fewer sidebar destination; remote connection CRUD,
  discovery, and dialogs are unchanged and still backed by
  `/api/remote-agents`. The axe check for harness UX is scoped to the new
  section (`data-testid="remote-agents-section"`) since the shared app shell
  has unrelated pre-existing violations.
