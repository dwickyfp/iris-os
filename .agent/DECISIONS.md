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
