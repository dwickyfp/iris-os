# IRIS-OS V2 — Learning Workspace Architecture & Implementation Specification

> **Status:** Proposed V2 Product & Engineering Specification
> **Repository:** https://github.com/dwickyfp/iris-os
> **Primary objective:** Evolve IRIS-OS from an AI chat/workflow workspace into a **personal AI operating system that learns how the user works**.
> **Audience:** Coding agents, maintainers, product/architecture agents, reviewers
> **Implementation strategy:** Incremental enhancement. **Do not rewrite IRIS-OS from scratch.** Preserve existing agents, MCP, skills, workflows, chat, voice, studio, memory, authentication, and provider abstractions unless a migration is explicitly required.

---

# 0. Executive Summary

IRIS-OS V2 should not be defined by “more AI features”.

It should be defined by a compounding loop:

```text
User Work
   ↓
Workspace Context
   ↓
Task / Activity
   ↓
Agent Execution
   ↓
Tools / MCP / Skills / Workflows
   ↓
Experience + Outcome
   ↓
Observation
   ↓
Memory
   ↓
Pattern Detection
   ↓
Reusable Skill
   ↓
Workflow
   ↓
Automation
   ↓
Better Future Work
```

The product should become measurably more useful the longer a user works inside it.

The V2 north-star is:

> **IRIS is a personal AI operating system that learns how you work.**

This means IRIS must be able to:

1. understand persistent workspace/project context,
2. remember facts, preferences, decisions, goals, procedures, relationships, and task state,
3. separate global user knowledge from workspace/agent/task-specific knowledge,
4. learn from both what the user **says** and what the user **does**,
5. detect recurring patterns,
6. convert stable recurring patterns into reusable skills,
7. convert repeated skills/processes into workflows,
8. attach workflows to schedules/events/triggers,
9. track ongoing tasks independent of chat history,
10. delegate work to specialist agents,
11. expose what it learned and why,
12. provide audit, approval, rollback, and safety controls.

IRIS V2 must therefore introduce six central first-class concepts:

```text
Workspace
Memory Scope + Memory Hierarchy
Work / Task Ledger
Learning Engine
Automation / Triggers
Agent Delegation
```

These should compose with existing IRIS concepts:

```text
Chat
Agents
Skills
MCP Tools
Workflows
Voice
Studio
Memory
```

---

# 1. Current IRIS-OS Baseline

Before modifying the platform, the implementation agent MUST inspect the current `main` branch and treat the current code as source of truth.

Known current architectural characteristics include:

- Next.js application.
- Multi-provider AI model abstraction.
- Vercel AI SDK based chat/agent execution.
- PostgreSQL / Drizzle persistence.
- Better Auth.
- MCP integration.
- Custom agents.
- Reusable skills.
- Visual workflows.
- Built-in tools.
- Memory subsystem.
- Background memory review.
- Memory graph concepts.
- Hybrid memory recall.
- Voice and Studio surfaces.
- Tool approval modes.
- File storage.
- Chat streaming.

Important current areas to inspect before implementing V2:

```text
src/app/api/chat/route.ts
src/lib/ai/memory/
src/lib/ai/agent/
src/lib/ai/workflow/
src/lib/ai/mcp/
src/lib/ai/tools/
src/lib/ai/skill/            # if present; confirm exact current path
src/types/memory.ts
src/types/skill.ts
database schema / repositories / migrations
chat UI components
agent management UI
workflow UI
settings UI
```

Do not assume filenames that are not present. Locate the current repository implementation first.

## 1.1 Existing memory baseline

At the time of this specification, `src/types/memory.ts` defines the top-level memory kinds approximately as:

```ts
preference
fact
goal
```

The existing system also includes concepts such as:

- confidence,
- memory status,
- provenance,
- source thread/message,
- versioning,
- expiry,
- topics,
- entities,
- evidence,
- graph nodes,
- graph edges,
- `ABOUT`,
- `SUPPORTS`,
- `REFINES`,
- `RELATED_TO`,
- `CONTRADICTS`,
- `SUPERSEDES`,
- background review,
- hybrid recall.

This is a strong foundation and MUST be evolved, not discarded.

## 1.2 Existing runtime baseline

The chat runtime currently composes model/agent/tool/workflow/memory context in the central chat execution path.

V2 should gradually extract reusable context assembly and work execution responsibilities out of a single chat-centric path where appropriate.

The target is:

```text
Chat is one client of the IRIS Runtime.
Chat is not the IRIS Runtime itself.
```

---

# 2. V2 Product Principles

Every V2 feature must follow these principles.

## 2.1 Workspace over conversation

A conversation is temporary interaction history.

A workspace is durable work context.

IRIS should understand that:

```text
"IRIS-OS"
```

is a persistent project/workspace containing:

- goals,
- tasks,
- files,
- repository connections,
- decisions,
- people,
- skills,
- workflows,
- active agents,
- history,
- knowledge,
- learned preferences,
- automations.

Users should not need to recreate this context in every chat.

## 2.2 Action over answers

The platform must optimize for completing work, not only producing responses.

A V2 answer should frequently be able to become:

```text
result
task
artifact
memory
decision
skill
workflow
automation
```

## 2.3 Learning must change future behavior

Storing memories without changing execution behavior is insufficient.

Every learned item should have a possible downstream effect:

```text
Memory
  → context selection
  → model behavior
  → tool choice
  → agent choice
  → output format
  → workflow recommendation
  → automation recommendation
```

## 2.4 Explicit scope

All durable knowledge must have an explicit scope.

No learning system should silently assume that a fact learned in one project applies everywhere.

## 2.5 User control

The user must be able to:

- inspect learned information,
- correct it,
- delete it,
- change scope,
- see supporting evidence,
- reject inferred patterns,
- disable behavioral learning,
- disable automation,
- require approval,
- undo actions when possible.

## 2.6 Progressive autonomy

Autonomy should grow through trust.

Recommended autonomy ladder:

```text
Level 0 — Observe only
Level 1 — Suggest
Level 2 — Prepare action
Level 3 — Execute with approval
Level 4 — Execute autonomously within policy
```

Different actions may use different autonomy levels.

## 2.7 Composability

Workspace, Task, Memory, Skill, Agent, Tool, Workflow, and Automation must remain useful independently but work better together.

---

# 3. Target Domain Model

V2 target conceptual model:

```text
User
 ├── Global Memory
 ├── Preferences
 ├── Connections
 └── Workspaces
      ├── Members / Roles (future-ready)
      ├── Conversations
      ├── Files / Resources
      ├── Knowledge
      ├── Decisions
      ├── Tasks
      │    ├── Activity
      │    ├── State
      │    └── Outputs
      ├── Agents
      ├── Skills
      ├── Workflows
      ├── Automations
      ├── Workspace Memory
      └── Audit Log
```

Runtime:

```text
User Intent
    ↓
Workspace Resolver
    ↓
Task Resolver
    ↓
Context Planner
    ↓
Relevant Memory
+ Relevant Knowledge
+ Workspace State
+ Active Task
+ Agent Instructions
+ Skills
+ Tool Permissions
    ↓
Agent Runtime
    ↓
Model + Tools + MCP + Workflows + Delegation
    ↓
Result
    ↓
Activity Events
    ↓
Learning Engine
    ↓
Memory / Pattern / Skill Candidate / Automation Candidate
```

---

# 4. Enhancement A — Workspace as a First-Class Primitive

## 4.1 Goal

Introduce a durable container that represents a project, role, client, personal area, or recurring work context.

Examples:

```text
IRIS-OS
Biztech Platform
Personal Finance
Research
Marketing 2027
Client — ACME
```

## 4.2 Required capabilities

A workspace MUST support:

- id,
- owner,
- name,
- slug,
- description,
- icon/color metadata,
- instructions,
- status,
- created/updated timestamps,
- default model preference,
- default agent preference,
- default tool policy,
- workspace-specific memory,
- workspace-specific knowledge,
- associated conversations,
- associated files,
- associated tasks,
- associated agents,
- associated skills,
- associated workflows,
- associated automations,
- external resource connections.

Suggested type:

```ts
type Workspace = {
  id: string;
  userId: string;
  name: string;
  slug: string;
  description?: string;
  instructions?: string;

  status: "active" | "archived";

  defaultModelId?: string;
  defaultAgentId?: string;
  defaultToolMode?: "auto" | "manual" | "none";

  metadata?: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
};
```

## 4.3 Workspace membership

V2 may initially remain single-user, but the data model SHOULD be future-ready for collaborative membership.

Suggested:

```ts
WorkspaceMember {
  workspaceId
  userId
  role: owner | admin | member | viewer
}
```

Do not block V2 on full multi-user collaboration.

## 4.4 Workspace context

Each workspace should have human-editable instructions:

```md
# Workspace Instructions

This project is IRIS-OS.

Primary repository:
dwickyfp/iris-os

Engineering conventions:
- use pnpm
- preserve existing architecture
- do not perform destructive DB migrations without review
- prefer incremental implementation

Current priorities:
- learning memory
- workspace runtime
- automation
```

These instructions are trusted configuration, unlike recalled memory.

## 4.5 Workspace resolver

Every chat or work execution should resolve a workspace.

Resolution order:

```text
explicit workspace selected
    ↓
thread.workspaceId
    ↓
active UI workspace
    ↓
user default workspace
    ↓
no workspace / global mode
```

Do NOT infer and persist a workspace solely from weak semantic similarity without user confirmation.

## 4.6 Workspace UI

Add a workspace selector in the main shell/sidebar.

Workspace home should show:

```text
Workspace: IRIS-OS

Overview
 ├── Active tasks
 ├── Recent activity
 ├── Recent conversations
 ├── Important memory
 ├── Recent decisions
 ├── Connected resources
 ├── Suggested improvements
 └── Automations

Knowledge
Tasks
Conversations
Agents
Skills
Workflows
Automations
Memory
Activity
Settings
```

## 4.7 Workspace chat flow

New chat:

```text
Select workspace: IRIS-OS
        ↓
Create thread(workspaceId)
        ↓
Build workspace context
        ↓
Recall scoped memory
        ↓
Resolve active task if applicable
        ↓
Run agent
```

User:

```text
"Lanjutkan memory v2."
```

IRIS should be able to resolve:

```text
workspace = IRIS-OS
active/relevant task = Memory V2
recent activity = last implementation state
relevant decisions = memory architecture decisions
relevant files = architecture docs
```

instead of searching all global chat history indiscriminately.

## 4.8 Workspace acceptance criteria

- A conversation can belong to a workspace.
- A user can switch workspaces.
- Workspace-specific instructions affect runtime context.
- Workspace-specific memory never leaks into unrelated workspaces unless explicitly global.
- Workspace deletion/archive behavior is defined.
- Existing chats without workspace remain functional.
- Migration is backward-compatible.
- Existing global chat mode remains available.

---

# 5. Enhancement B — Memory Hierarchy V2

## 5.1 Goal

Expand memory from a small collection of user facts into a structured representation of the user's work and world.

## 5.2 Memory kinds

Replace or extend the current three categories with a richer taxonomy.

Recommended:

```ts
type MemoryKind =
  | "identity"
  | "preference"
  | "semantic"
  | "episodic"
  | "decision"
  | "procedure"
  | "operational"
  | "relationship"
  | "goal";
```

Backward mapping:

```text
existing preference → preference
existing fact       → semantic
existing goal       → goal
```

Do not destroy old data.

## 5.3 Meaning of each memory kind

### identity

Relatively stable user identity/context.

Examples:

```text
User works on IRIS-OS.
User frequently manages software projects.
```

Avoid storing sensitive identity attributes unless explicitly requested and allowed by product policy.

### preference

How the user prefers results, interaction, tools, or workflows.

Examples:

```text
Prefer pnpm over npm.
Prefer concise executive summaries.
Prefer approval before destructive operations.
```

### semantic

Facts and domain knowledge.

Examples:

```text
IRIS-OS uses PostgreSQL.
The API runs on Next.js.
```

### episodic

What happened.

Examples:

```text
On 2026-08-14 the user discussed IRIS V2 memory architecture.
The deployment failed because migration X was missing.
```

Episodic memory should usually be summarized and selectively retained, not every interaction.

### decision

A decision plus rationale and alternatives.

Example:

```yaml
subject: database
choice: PostgreSQL
rejected:
  - MongoDB
reason:
  - reporting query requirements
scope: workspace
```

### procedure

How the user performs recurring work.

Example:

```text
When reviewing a PR:
1. architecture
2. security
3. tests
4. summary
```

A stable procedure is a candidate for conversion into a Skill.

### operational

Current work state.

Examples:

```text
Memory V2 implementation is in progress.
Next step is conflict resolution testing.
Deployment is blocked by environment configuration.
```

Operational memory should normally have a shorter lifecycle.

### relationship

Entities and relationships relevant to work.

Examples:

```text
Alice is the product owner for Project X.
Repository Y belongs to Workspace Z.
```

### goal

Desired future state.

Examples:

```text
Make IRIS learn how the user works.
Ship V2 workspace foundation.
```

## 5.4 Memory scope

Every memory MUST have a scope.

Recommended:

```ts
type MemoryScopeType =
  | "global"
  | "workspace"
  | "agent"
  | "task"
  | "thread";
```

Suggested fields:

```ts
scopeType: MemoryScopeType;
scopeId?: string;
```

Rules:

```text
global    → applies to user generally
workspace → only applies inside workspace
agent     → behavior/context specific to an agent
task      → context specific to work item
thread    → conversation-local durable memory, rarely needed
```

## 5.5 Memory temporal model

Add temporal metadata:

```ts
validFrom?: Date;
validUntil?: Date;

lastConfirmedAt?: Date;
lastObservedAt?: Date;

stability?: "temporary" | "medium" | "stable";
```

Examples:

```text
"I am currently debugging login."
→ temporary operational memory

"I prefer pnpm."
→ stable preference

"Use Gemini for this task."
→ task-scoped preference, not global
```

## 5.6 Memory quality signals

Recommended fields:

```ts
confidence: number;
importance: number;
frequency: number;
stabilityScore: number;
lastObservedAt?: Date;
lastConfirmedAt?: Date;
```

Retrieval should not be based solely on semantic similarity.

Potential ranking:

```text
score =
  semanticSimilarity
  * scopeWeight
  * confidenceWeight
  * importanceWeight
  * recencyFunction
  * stabilityFunction
```

Exact formula can evolve behind an abstraction.

## 5.7 Evidence

Every inferred memory SHOULD be connected to evidence.

Evidence sources can include:

```text
chat_message
user_edit
tool_action
tool_result
workflow_run
task_event
file_change
manual_entry
user_confirmation
external_resource
```

Suggested model:

```ts
MemoryEvidence {
  id: string;
  userId: string;
  memoryId: string;

  evidenceType:
    | "chat_message"
    | "behavior"
    | "tool_action"
    | "workflow_run"
    | "task_event"
    | "manual"
    | "confirmation";

  sourceId?: string;
  excerpt?: string;
  metadata?: Record<string, unknown>;

  createdAt: Date;
}
```

## 5.8 Memory relations

Preserve existing graph relations and extend only where useful.

Existing relations such as:

```text
SUPPORTS
REFINES
CONTRADICTS
SUPERSEDES
RELATED_TO
ABOUT
```

are useful.

Potential V2 additions:

```text
DERIVED_FROM
APPLIES_TO
BLOCKED_BY
DEPENDS_ON
PART_OF
```

Do not introduce relations without real retrieval/use cases.

## 5.9 Decision memory structure

Decision memories deserve structured payload.

Suggested:

```ts
type DecisionMemoryPayload = {
  subject: string;
  choice: string;
  alternatives?: string[];
  rationale?: string[];
  constraints?: string[];
  consequences?: string[];
};
```

Store human-readable content plus structured metadata.

## 5.10 Procedure memory structure

Suggested:

```ts
type ProcedureMemoryPayload = {
  trigger?: string;
  steps: Array<{
    order: number;
    instruction: string;
    toolHint?: string;
  }>;
  expectedOutcome?: string;
};
```

## 5.11 Operational memory lifecycle

Operational memories should decay/archive aggressively.

Example default policy:

```text
temporary operational state:
  expire after 7–30 days unless referenced

completed task operational memory:
  compress into episode / decision / lesson
```

## 5.12 Memory retrieval order

Context construction SHOULD query from most specific to broadest:

```text
Task memory
    +
Agent-scoped memory
    +
Workspace memory
    +
Global memory
    +
Relevant episodic history
```

Each bucket needs a token budget.

Example:

```text
task      25%
workspace 35%
global    20%
episode   20%
```

Dynamic budgeting is preferred.

## 5.13 Memory isolation invariant

Critical requirement:

> Retrieval, deduplication, conflict detection, and superseding MUST respect memory scope.

A workspace fact must not supersede a global fact unless the system explicitly decides they represent the same scope and claim.

## 5.14 Migration requirements

The implementation agent must:

1. inspect existing memory tables and repositories,
2. create backward-compatible migrations,
3. map old `fact` records to `semantic`,
4. set old records to `scopeType = global`,
5. preserve evidence,
6. preserve graph edges,
7. preserve confidence/status/version/provenance,
8. ensure old users lose no memory.

---

# 6. Enhancement C — Learning Engine

## 6.1 Goal

Create a dedicated subsystem that turns user activity into durable learning.

Recommended module boundary:

```text
src/lib/ai/learning/
```

Suggested internal components:

```text
learning/
  observation.ts
  extractor.ts
  classifier.ts
  pattern-detector.ts
  candidate-service.ts
  promotion-policy.ts
  feedback.ts
  queue.ts
  types.ts
```

Exact repository layout may differ.

## 6.2 Learning pipeline

Target:

```text
Activity Event
     ↓
Observation Extraction
     ↓
Classification
     ↓
Scope Resolution
     ↓
Existing Memory Retrieval
     ↓
Relation / Conflict Analysis
     ↓
Candidate
     ↓
Policy Decision
 ┌──────┼─────────┐
 ↓      ↓         ↓
ignore pending   auto-store
         ↓
   user confirmation
         ↓
      active memory
```

## 6.3 Observation model

An observation is not yet a memory.

Example:

```ts
type LearningObservation = {
  id: string;
  userId: string;

  workspaceId?: string;
  taskId?: string;
  threadId?: string;

  type:
    | "statement"
    | "behavior"
    | "outcome"
    | "correction"
    | "repetition"
    | "tool_usage"
    | "edit"
    | "approval"
    | "rejection";

  content: string;

  sourceType: string;
  sourceId?: string;

  confidence: number;
  createdAt: Date;
};
```

## 6.4 Learn from statements

Current memory behavior should remain.

Examples:

```text
"I prefer pnpm."
"IRIS uses Postgres."
"My goal is to make IRIS an AI OS."
```

## 6.5 Learn from behavior

V2 must record useful behavior signals.

Examples:

```text
assistant result accepted
assistant result regenerated
artifact edited
tool approved
tool rejected
tool undone
model switched
agent switched
workflow manually repeated
same sequence of tools repeated
user reformatted result
user shortened generated text
user repeatedly attaches same resources
```

Do not treat every click as memory-worthy.

Behavior is evidence.

Repeated behavior becomes a candidate pattern.

## 6.6 Event instrumentation

Introduce a normalized event layer:

```ts
type IrisActivityEvent = {
  id: string;
  userId: string;

  workspaceId?: string;
  taskId?: string;
  threadId?: string;
  agentId?: string;

  eventType: string;

  subjectType?: string;
  subjectId?: string;

  payload?: Record<string, unknown>;

  occurredAt: Date;
};
```

Candidate event types:

```text
message.sent
message.completed
message.regenerated

artifact.created
artifact.edited
artifact.accepted

tool.requested
tool.approved
tool.rejected
tool.executed
tool.failed
tool.undone

workflow.started
workflow.completed
workflow.failed

skill.invoked
skill.completed

task.created
task.status_changed
task.completed

agent.delegated
agent.completed

workspace.resource_opened

memory.confirmed
memory.corrected
memory.deleted
```

Do NOT log secrets or raw sensitive payloads by default.

## 6.7 Behavioral pattern detection

Pattern detector should operate asynchronously.

Example:

```text
Observation 1: user edits report to bullets
Observation 2: user edits report to bullets
Observation 3: user asks "make this shorter"
Observation 4: user edits another report to bullets
```

Candidate:

```yaml
kind: preference
scope: workspace
content: Prefer executive-style concise bullet summaries for reports.
confidence: 0.78
evidenceCount: 4
```

## 6.8 Confidence policy

Example initial policy:

```text
explicit statement:
  confidence 0.9–1.0

explicit user confirmation:
  confidence 1.0

single inferred behavior:
  confidence 0.2–0.4

3 consistent observations:
  confidence 0.5–0.7

5+ consistent observations:
  confidence 0.7–0.9
```

This is a starting policy, not a hard scientific truth.

Keep thresholds configurable.

## 6.9 Promotion policy

Candidate actions:

```text
ignore
keep_observing
ask_user
activate
propose_skill
propose_workflow
```

Example:

```text
high-confidence non-sensitive preference
→ may auto-activate

low-confidence inferred identity information
→ never auto-activate

repeatable 4-step procedure
→ propose skill

repeated skill on schedule
→ propose automation
```

## 6.10 Learning from corrections

Corrections are extremely valuable.

Example:

```text
IRIS: "You usually deploy on Friday."
User: "No, only production releases are Friday."
```

The correction should:

1. create evidence,
2. refine/supersede the old claim,
3. reduce confidence of incorrect inference,
4. update scope if appropriate,
5. prevent repeated mistake.

## 6.11 Negative feedback

Persist useful negative signals:

```text
memory rejected
suggestion dismissed
automation rejected
tool repeatedly denied
skill recommendation ignored
```

Do not repeatedly suggest the same rejected learning unless materially new evidence appears.

---

# 7. Enhancement D — Learning Inbox

## 7.1 Goal

Provide a transparent UI for IRIS learning.

Suggested navigation:

```text
Workspace
  → Memory
     → Learned
     → Suggestions
     → Conflicts
     → History
```

Or global:

```text
Settings → Learning & Memory
```

## 7.2 Suggested UI

```text
Iris learned 4 things

Confirmed
✓ You prefer pnpm for JavaScript projects.
✓ IRIS-OS uses PostgreSQL.

Needs review
? You usually review architecture before implementation.
  Evidence: 5 recent tasks
  Scope: IRIS-OS
  [Confirm] [Edit] [Ignore]

? Reports are usually converted into short executive bullets.
  Evidence: 4 edits
  Scope: Global
  [Confirm] [Change scope] [Ignore]
```

## 7.3 Memory card requirements

Each card should show:

- content,
- kind,
- scope,
- confidence,
- status,
- last observed,
- source/evidence count,
- why IRIS believes it,
- edit action,
- delete action,
- scope action,
- confirm action,
- reject action.

## 7.4 Conflict UI

Example:

```text
Conflict detected

Old:
"Use npm for Node projects."

New:
"Use pnpm for Node projects."

Evidence:
- explicit statement 2026-08-14
- 8 recent pnpm executions

[Use new]
[Keep old]
[Apply pnpm only to IRIS-OS]
[Edit]
```

## 7.5 Learning settings

Suggested controls:

```text
Learning
[x] Learn from conversations
[x] Learn from repeated behavior
[x] Learn from corrections
[x] Suggest reusable skills
[x] Suggest automations

Autonomous memory:
[ ] Automatically save inferred preferences
[ ] Automatically save inferred procedures

Privacy:
[x] Show evidence for learned items
[x] Allow delete all learned behavior
```

Defaults should favor transparency and user control.

---

# 8. Enhancement E — Memory → Skill Learning

## 8.1 Goal

Turn stable procedures into reusable procedural capabilities.

This is one of the most important V2 differentiators.

## 8.2 Skill candidate flow

```text
Repeated Task Episodes
       ↓
Procedure Observations
       ↓
Pattern Detector
       ↓
Procedure Memory
       ↓
Skill Candidate Generator
       ↓
Learning Inbox
       ↓
User Approval
       ↓
Skill Created
       ↓
Skill Usage Telemetry
       ↓
Skill Improvement Candidate
```

## 8.3 Example

Observed:

```text
PR review #1:
architecture → security → tests → summary

PR review #2:
architecture → security → tests → summary

PR review #3:
architecture → security → tests → summary
```

IRIS:

```text
I noticed you use the same PR review process repeatedly.

Create a reusable skill?

Name: review-pr
Steps:
1. inspect architecture
2. inspect security concerns
3. inspect tests
4. produce concise summary
```

User:

```text
Create Skill
```

## 8.4 Skill generation requirements

Generated skills should:

- use the existing IRIS Skill model,
- have explicit provenance such as `learned` / `generated`,
- contain human-readable instructions,
- declare only required tools,
- be editable,
- be versioned,
- preserve source learning candidate,
- not silently gain destructive tool permission.

Suggested provenance extension:

```ts
manual
imported
generated
learned
```

Confirm exact current schema before modifying.

## 8.5 Skill evolution

After a skill runs, observe:

```text
success
failure
user correction
user edit
tool failure
step skipped
step added
```

IRIS can then propose:

```text
"review-pr has been corrected in the same way 3 times.
Update the skill to run security checks before dependency analysis?"
```

Never automatically rewrite a high-impact skill without policy/approval.

## 8.6 Skill effectiveness metrics

Track:

```text
invocationCount
successRate
userCorrectionRate
averageSteps
averageDuration
toolFailureRate
lastUsedAt
```

These metrics should support improvement, not become hidden behavioral scoring of the user.

---

# 9. Enhancement F — Work / Task Ledger

## 9.1 Goal

Create persistent work state independent of conversation history.

A chat answers:

```text
"What did we say?"
```

A task ledger answers:

```text
"What are we doing?"
"What is done?"
"What is blocked?"
"What happens next?"
```

## 9.2 Task model

Suggested:

```ts
type Task = {
  id: string;
  userId: string;
  workspaceId: string;

  parentTaskId?: string;

  title: string;
  description?: string;

  status:
    | "backlog"
    | "todo"
    | "in_progress"
    | "blocked"
    | "waiting"
    | "done"
    | "cancelled";

  priority?: "low" | "medium" | "high" | "urgent";

  assignedAgentId?: string;

  dueAt?: Date;
  startedAt?: Date;
  completedAt?: Date;

  nextAction?: string;

  metadata?: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
};
```

## 9.3 Task activity

```ts
TaskActivity {
  id
  taskId
  actorType: user | agent | workflow | system
  actorId?
  eventType
  summary
  metadata?
  createdAt
}
```

## 9.4 Task outputs

A task can reference:

```text
threads
files
artifacts
workflow runs
tool executions
decisions
memory
external URLs
commits/PRs
```

Use generic resource references rather than dozens of nullable columns where possible.

## 9.5 Task creation flow

Explicit:

```text
User: "Create a task to implement workspace memory."
→ create task
```

Agent suggestion:

```text
User: "We should implement workspace memory later."
IRIS:
"Add this as a task?"
```

Do not automatically convert every future-tense statement to a task.

## 9.6 Task continuation flow

User:

```text
"Continue Memory V2."
```

Runtime:

```text
resolve workspace
    ↓
retrieve candidate tasks
    ↓
select exact/high-confidence task
    ↓
load task state
    ↓
load last activity
    ↓
load relevant decision/operational memory
    ↓
continue
```

If multiple tasks are ambiguous, present compact choices.

## 9.7 Task checkpointing

Long agent jobs should create checkpoints:

```yaml
task: Implement Memory Scope
checkpoint:
  completed:
    - new type definitions
    - repository migration
  current:
    - retrieval policy
  next:
    - tests
  blockers: []
```

A checkpoint can be stored as task state and/or operational memory.

## 9.8 Task completion

On completion:

```text
operational memory
    ↓ compress
episode + decision + learned procedure + artifacts
```

Temporary state should not pollute long-term memory forever.

---

# 10. Enhancement G — Knowledge & Resource Workspace

## 10.1 Goal

Allow the user's real working environment to become addressable context.

A workspace should connect to resources such as:

```text
files
folders
repositories
web pages
documentation
MCP servers
cloud drives
email
calendar
databases
issue trackers
project systems
```

Do not implement all connectors in V2 foundation.

Create the abstraction first.

## 10.2 Workspace resource model

Suggested:

```ts
type WorkspaceResource = {
  id: string;
  workspaceId: string;
  userId: string;

  type:
    | "file"
    | "folder"
    | "repository"
    | "url"
    | "mcp"
    | "external_connection"
    | "artifact";

  name: string;
  uri?: string;

  provider?: string;
  externalId?: string;

  metadata?: Record<string, unknown>;

  status: "active" | "disconnected" | "archived";

  createdAt: Date;
  updatedAt: Date;
};
```

## 10.3 Resource context

The agent should not inject all workspace resources into every prompt.

Use context planning:

```text
intent
    ↓
resource candidates
    ↓
retrieval
    ↓
compact relevant context
```

## 10.4 Persistent environment abstraction

Long-term target:

```text
Workspace Runtime Environment
 ├── filesystem
 ├── repository
 ├── terminal
 ├── browser
 ├── secrets / credentials
 ├── connected accounts
 ├── artifacts
 └── jobs
```

This does NOT mean V2 must immediately provide a persistent container.

The architecture should make such an environment possible later.

---

# 11. Enhancement H — Automation and Triggers

## 11.1 Goal

Allow workflows/agents to operate without requiring a new chat message.

Target:

```text
Trigger
  ↓
Automation
  ↓
Agent / Workflow / Skill
  ↓
Tools
  ↓
Result
  ↓
Notification / Artifact / Task Update
```

## 11.2 Trigger types

Foundation should support:

```ts
type TriggerType =
  | "manual"
  | "schedule"
  | "webhook"
  | "event";
```

Event adapters can later include:

```text
email.received
calendar.event_upcoming
github.pr_created
github.issue_assigned
file.created
task.due
task.status_changed
workspace.activity
```

## 11.3 Automation model

Suggested:

```ts
type Automation = {
  id: string;
  userId: string;
  workspaceId?: string;

  name: string;
  description?: string;

  enabled: boolean;

  triggerType: "manual" | "schedule" | "webhook" | "event";
  triggerConfig: Record<string, unknown>;

  targetType: "workflow" | "agent" | "skill";
  targetId: string;

  inputTemplate?: Record<string, unknown>;

  approvalPolicy:
    | "always"
    | "destructive_only"
    | "never";

  lastRunAt?: Date;
  nextRunAt?: Date;

  createdAt: Date;
  updatedAt: Date;
};
```

## 11.4 Automation run

```ts
AutomationRun {
  id
  automationId
  status: queued | running | completed | failed | cancelled
  triggerPayload
  output?
  error?
  startedAt?
  completedAt?
}
```

## 11.5 Scheduler requirements

For schedule triggers:

- use durable persistence,
- use idempotency keys,
- prevent double runs,
- handle retry policy,
- handle missed runs,
- record execution history,
- respect timezones,
- support disable/pause.

Do not rely only on in-memory Node timers.

## 11.6 Automation approval

Automation must inherit the platform's human-control principle.

Examples:

```text
read calendar → autonomous allowed
summarize email → autonomous allowed
create draft → maybe autonomous
send email → approval by default
delete files → approval
merge PR → approval unless explicit policy
```

Tool policy should be enforced at execution time, not only in UI.

## 11.7 Learning → automation proposal

Example:

```text
Pattern:
User manually runs Morning Brief workflow at 08:00 on 8 weekdays.

IRIS:
"You usually run Morning Brief around 08:00.
Schedule it automatically on weekdays?"

[Create automation]
[Not now]
[Never suggest this]
```

## 11.8 Workflow enhancement

Existing visual workflows should gain trigger metadata without breaking their current ability to be invoked as tools.

Possible approach:

```text
Workflow remains reusable logic.
Automation binds a trigger to a workflow.
```

Prefer this separation over embedding schedules directly into workflow definitions.

---

# 12. Enhancement I — Agent Delegation / Subagents

## 12.1 Goal

Allow an orchestrating agent to delegate bounded work to specialist agents.

## 12.2 Core primitive

Conceptually:

```ts
delegateTask({
  agentId,
  task,
  context,
  expectedOutput,
  timeout,
});
```

## 12.3 Execution model

```text
Parent Agent
   ├── Research Agent
   ├── Coding Agent
   └── Reviewer Agent
          ↓
      structured results
          ↓
      Parent synthesis
```

## 12.4 Isolation

Subagent execution should have:

- isolated message context,
- explicit token budget,
- explicit tool permissions,
- explicit workspace/task context,
- timeout,
- max steps,
- cancellation,
- structured return.

Do not give every subagent every available tool by default.

## 12.5 Parallel delegation

Allow independent tasks to run concurrently when safe.

Example:

```text
Research architecture
Security review
UX review
```

Then aggregate.

## 12.6 Delegation result

Suggested result:

```ts
type DelegationResult = {
  status: "completed" | "failed" | "cancelled";
  summary: string;
  output?: unknown;
  artifacts?: ResourceRef[];
  activityIds?: string[];
};
```

## 12.7 UI

Show execution as work, not hidden chain-of-thought.

Example:

```text
Implementing IRIS V2

✓ Architect
  Architecture proposal completed

● Engineer
  Implementing workspace schema

● Reviewer
  Waiting for implementation

✓ Researcher
  Memory comparison complete
```

Do not expose private model chain-of-thought.

Show observable actions, status, tool calls, outputs, checkpoints, and summaries.

---

# 13. Enhancement J — Context Planner

## 13.1 Goal

Avoid turning V2 into a giant prompt that injects everything.

Create a context planning layer.

Suggested architecture:

```text
Request
  ↓
Context Planner
  ├── Workspace context
  ├── Task context
  ├── Memory recall
  ├── Knowledge retrieval
  ├── Agent instructions
  ├── Skill instructions
  └── Recent conversation
  ↓
Context Budgeter
  ↓
Model Prompt
```

## 13.2 Context priority

Recommended high-level priority:

```text
1. System safety/runtime instructions
2. Explicit user current request
3. Active task state
4. Workspace trusted instructions
5. Agent instructions
6. Required skill instructions
7. Relevant scoped memory
8. Relevant knowledge/resources
9. Conversation history
10. Low-confidence episodic context
```

Current user intent always beats old memory.

## 13.3 Context provenance

Internally attach provenance:

```text
trusted config
user current message
memory
retrieved document
tool result
external data
```

Memory and retrieved content must remain untrusted data, not executable instructions.

## 13.4 Context debugging

Developer mode should optionally show:

```text
Context used
- Workspace instructions
- Task #123
- 4 memories
- 2 knowledge chunks
- Skill review-pr
```

Do not display sensitive prompt internals by default.

---

# 14. Enhancement K — Trust, Audit, Undo

## 14.1 Goal

As IRIS becomes more autonomous, every meaningful action must be understandable.

## 14.2 Activity / audit log

Record meaningful actions:

```text
Agent invoked
Tool requested
Tool approved
Tool executed
Workflow started
Workflow completed
Memory created
Memory changed
Skill proposed
Skill created
Automation triggered
Task updated
External action performed
```

## 14.3 Audit model

Can reuse `IrisActivityEvent` where possible.

Need:

- actor,
- action,
- scope,
- target,
- timestamp,
- result,
- approval,
- metadata,
- correlation/run ID.

## 14.4 Undo

Introduce optional tool compensation contract.

Example:

```ts
type UndoableToolResult = {
  result: unknown;
  undo?: {
    label: string;
    token: string;
    expiresAt?: Date;
  };
};
```

Not all operations are reversible.

UI must never falsely imply reversibility.

## 14.5 Approval policy

Approval decisions should support scope:

```text
once
for this task
for this workspace
always for this tool
```

High-impact actions should remain conservative.

---

# 15. Enhancement L — Learning Evaluation & Telemetry

## 15.1 Goal

Measure whether IRIS actually becomes more useful.

## 15.2 Learning quality metrics

Track aggregate/product metrics such as:

```text
memory confirmation rate
memory rejection rate
memory correction rate

retrieved-memory usefulness proxy
conflict rate
stale-memory rate

skill proposal acceptance rate
skill correction rate
skill reuse rate

automation proposal acceptance
automation success rate

task continuation success
workspace context resolution success
```

## 15.3 Important distinction

Do NOT optimize for:

```text
more memories
more automations
more tool calls
```

Optimize for:

```text
less repeated user explanation
fewer repeated corrections
less repetitive work
higher task completion
higher accepted suggestions
```

## 15.4 Evaluation scenarios

Create test scenarios:

### Scenario A — Preference learning

```text
User repeatedly requests concise reports.
IRIS learns preference.
Future report defaults concise.
```

### Scenario B — Scoped project fact

```text
Workspace A uses npm.
Workspace B uses pnpm.
No leakage.
```

### Scenario C — Decision recall

```text
User previously chose PostgreSQL due reporting requirements.
Later agent proposes Mongo.
IRIS surfaces previous decision and rationale.
```

### Scenario D — Procedure learning

```text
Repeated PR review process.
IRIS proposes skill.
User confirms.
Skill becomes reusable.
```

### Scenario E — Task continuation

```text
User leaves task midway.
Returns 5 days later.
Says "continue".
IRIS restores task state.
```

### Scenario F — Automation learning

```text
User runs workflow repeatedly on a schedule.
IRIS suggests automation.
```

---

# 16. Data Architecture Proposal

This section is conceptual. The coding agent MUST adapt it to the existing Drizzle schema conventions.

## 16.1 New logical entities

Potential new tables/entities:

```text
workspaces
workspace_members            # future-ready
workspace_resources

tasks
task_activities
task_resources

activity_events

learning_observations
learning_candidates
learning_feedback

automations
automation_runs

agent_runs                    # if not already represented
delegation_runs               # can potentially reuse agent_runs
```

Existing memory tables should be evolved rather than duplicated.

## 16.2 Memory fields to add

Conceptually:

```text
kind
scope_type
scope_id

importance
frequency
stability_score

valid_from
valid_until
last_observed_at
last_confirmed_at

structured_payload JSONB
```

Do not add every field blindly. Reconcile with current schemas first.

## 16.3 Generic resource reference

Useful abstraction:

```ts
type ResourceRef = {
  type:
    | "thread"
    | "file"
    | "artifact"
    | "task"
    | "workflow_run"
    | "tool_run"
    | "repository"
    | "url";
  id?: string;
  uri?: string;
  label?: string;
};
```

## 16.4 Index requirements

Likely indexes:

```text
workspace owner + status
thread workspace
task workspace + status
memory user + scope + status
memory lastObserved
activity workspace + timestamp
activity task + timestamp
automation enabled + nextRun
learning candidate user + status
```

Vector/semantic indexes should incorporate scope filtering.

## 16.5 Cascade policy

Define deletion semantics deliberately.

Examples:

```text
archive workspace
→ keep data, hide from normal views

delete memory
→ soft delete + remove from retrieval

delete workspace
→ destructive operation with confirmation
→ avoid accidental external resource deletion
```

---

# 17. API / Service Architecture

## 17.1 Avoid overloading `/api/chat`

The central chat route can remain the entry point for chat, but V2 should move domain logic into services.

Recommended conceptual services:

```text
WorkspaceService
TaskService
MemoryService
LearningService
ContextPlanner
AutomationService
AgentRuntime
DelegationService
ActivityService
```

## 17.2 Runtime request context

Introduce a common runtime object:

```ts
type IrisRuntimeContext = {
  userId: string;

  workspaceId?: string;
  threadId?: string;
  taskId?: string;
  agentId?: string;

  runId: string;

  toolMode: "auto" | "manual" | "none";

  metadata?: Record<string, unknown>;
};
```

Pass this consistently through:

```text
chat
agent runs
tool execution
workflow runs
memory
learning events
delegation
automation
```

## 17.3 Correlation IDs

All work spawned from one request should share correlation IDs.

Example:

```text
requestId
runId
parentRunId
taskId
automationRunId
```

This improves debugging/audit.

---

# 18. Detailed Flow — Chat to Learning

```text
1. User sends message
2. Resolve runtime context
   - user
   - workspace
   - thread
   - task
   - selected agent
3. Context Planner builds relevant context
4. Agent/model executes
5. Tools/workflows may execute
6. Stream answer to user
7. Persist message
8. Persist activity events
9. Enqueue Learning Review
10. Learning Engine extracts observations
11. Resolve scope
12. Compare with existing memories
13. Create/refine/conflict candidate
14. Apply promotion policy
15. Update Learning Inbox / memory
16. If repeated procedure:
    create Skill Candidate
17. If repeated execution pattern:
    create Automation Candidate
```

Learning must never block normal response latency unless explicitly required.

---

# 19. Detailed Flow — Behavioral Learning

```text
User receives generated report
        ↓
User edits 12 paragraphs → 5 bullets
        ↓
artifact.edited event
        ↓
Observation:
"User significantly shortened report and converted it to bullets"
        ↓
Pattern detector checks similar observations
        ↓
4 similar events found
        ↓
Candidate:
"Prefer concise bullet executive reports"
scope = workspace
confidence = 0.76
        ↓
Learning Inbox
        ↓
User confirms
        ↓
Preference memory active
        ↓
Context Planner recalls it for report tasks
```

---

# 20. Detailed Flow — Decision Memory

```text
Conversation:
"Let's use PostgreSQL because reporting queries are important."
        ↓
Learning extractor
        ↓
Decision candidate
        ↓
subject = database
choice = PostgreSQL
reason = reporting
scope = workspace IRIS-OS
        ↓
Memory stored
        ↓

Three months later:

User:
"Design new analytics storage."

Context Planner
        ↓
retrieves database decision
        ↓
Agent considers PostgreSQL decision
        ↓
If suggesting alternative:
"Existing workspace decision uses PostgreSQL for reporting requirements.
Changing this would be an architectural decision."
```

---

# 21. Detailed Flow — Memory Conflict

```text
Existing:
"Use npm for IRIS-OS."

New explicit user statement:
"From now on use pnpm for IRIS-OS."

        ↓
scope match
claim subject match
semantic contradiction/refinement
        ↓
create SUPERSEDES edge
        ↓
old memory → superseded
new memory → active
        ↓
evidence attached
```

If scope differs:

```text
Global: prefer npm
Workspace IRIS-OS: use pnpm
```

Both can coexist.

---

# 22. Detailed Flow — Memory to Skill

```text
Episode A
Episode B
Episode C
    ↓
same procedure pattern
    ↓
procedure memory
    ↓
skill candidate
    ↓
user review
    ↓
Skill created
    ↓
existing IRIS skill runtime
    ↓
invocation events
    ↓
improvement feedback
```

---

# 23. Detailed Flow — Skill to Workflow

A skill is procedural instruction/capability.

A workflow is explicit orchestration.

Example:

```text
Skill:
review-pr

Repeated work:
fetch PR
→ run review-pr
→ run tests
→ produce summary
→ post report
```

IRIS may suggest:

```text
"This process combines the same steps repeatedly.
Convert it into a workflow?"
```

Workflow creation should use existing visual workflow primitives.

---

# 24. Detailed Flow — Workflow to Automation

```text
Workflow exists:
Morning Brief

User manually runs it weekday mornings
        ↓
activity pattern
        ↓
automation candidate
        ↓
"Schedule at 08:00 weekdays?"
        ↓
user approves
        ↓
Automation
schedule trigger
        ↓
workflow execution
        ↓
notification/result
```

---

# 25. Detailed Flow — Task + Agent Delegation

```text
Task:
Prepare IRIS V2 architecture

Parent Iris
   ↓
creates/delegates subtasks

Research Agent
  compare memory architecture

Architecture Agent
  propose schemas

Engineering Agent
  inspect code impact

Reviewer Agent
  identify risks
   ↓
Parent waits/collects structured outputs
   ↓
synthesizes result
   ↓
updates task
   ↓
stores decisions
   ↓
learning review
```

---

# 26. Memory Curator V2

## 26.1 Current limitation to address

Current heuristic relation/topic logic is useful but should not be the sole mechanism for nuanced memory.

V2 curator should use:

```text
fast deterministic checks
     ↓
semantic candidate retrieval
     ↓
structured model judgment when needed
```

## 26.2 Hybrid classification

Recommended:

### Stage 1 — deterministic

```text
exact duplicate
normalized duplicate
same memory id
obvious scope mismatch
expiry checks
```

### Stage 2 — semantic retrieval

Find nearest candidate memories in the same relevant scope.

### Stage 3 — structured relation classifier

Return strict schema:

```ts
{
  relation:
    | "duplicate"
    | "refinement"
    | "conflict"
    | "supersedes"
    | "related"
    | "new";

  confidence: number;

  reason: string;
}
```

### Stage 4 — policy

Do not let the model directly mutate storage.

The model proposes classification.

Deterministic service code applies allowed transitions.

## 26.3 Memory injection safety

Continue treating recalled memory as untrusted data.

Memory content must never override:

- system instructions,
- security policy,
- tool permissions,
- current explicit user instruction.

---

# 27. Security & Privacy Requirements

## 27.1 Sensitive memory

Learning must include a sensitive-data policy.

At minimum:

```text
never infer/store secrets
API keys
passwords
session tokens
private keys
credit card data
authentication codes
```

unless a dedicated secure secret vault feature explicitly exists.

## 27.2 Prompt injection

External resources and memory are untrusted.

Workspace instructions entered explicitly through trusted settings are a separate trusted layer.

## 27.3 Tool permission inheritance

Delegated agents and automations must not accidentally widen permissions.

Rule:

```text
child permission ⊆ parent allowed permission
```

unless the user explicitly configures otherwise.

## 27.4 Automation security

Webhook/event triggers must validate authenticity.

Scheduled actions must run under current authorization policy.

Disconnected credentials should cause safe failure.

## 27.5 Deletion

User must be able to:

```text
delete memory
delete learned behavior
disable learning
archive workspace
delete workspace
delete automation
```

Define whether related audit metadata remains for security/accountability.

---

# 28. Backward Compatibility

V2 must not break:

- existing conversations,
- temporary chats,
- custom agents,
- existing skills,
- MCP servers,
- tool presets,
- workflows,
- voice,
- model providers,
- existing memory,
- file uploads,
- user settings.

Existing users should enter V2 with:

```text
existing memory → global scope
existing chats → no workspace or default workspace depending migration policy
existing agents → globally available unless later assigned
existing skills → globally available
existing workflows → globally available
```

Do not automatically move all content into arbitrary workspaces.

---

# 29. Suggested UX Navigation

Possible sidebar:

```text
IRIS
├── Home
├── Chat
├── Workspaces
│   ├── IRIS-OS
│   │   ├── Overview
│   │   ├── Chat
│   │   ├── Tasks
│   │   ├── Knowledge
│   │   ├── Agents
│   │   ├── Skills
│   │   ├── Workflows
│   │   ├── Automations
│   │   ├── Memory
│   │   └── Activity
│   └── ...
├── Agents
├── Skills
├── Workflows
└── Settings
    ├── Models
    ├── Connections
    ├── MCP
    ├── Learning & Memory
    └── Security
```

Avoid duplicating every global page inside every workspace if filters can provide a cleaner UI.

---

# 30. Home / OS Dashboard

To make IRIS feel less like a chatbot, create an OS-style home surface.

Suggested widgets:

```text
Good morning

Active Work
- Memory V2 — in progress
- Landing page — waiting for review

Iris Learned
- 2 new confirmed memories
- 1 procedure suggestion

Needs Attention
- Deployment workflow failed
- GitHub credential expired

Automations
- Morning Brief — completed 08:00
- Weekly Review — Friday

Recent Workspace
- IRIS-OS
- Biztech Platform

Ask Iris...
```

Chat remains immediately accessible but is no longer the only center of gravity.

---

# 31. IRIS "Continue Work" Experience

This should become a flagship interaction.

User:

```text
"Continue IRIS-OS."
```

IRIS should build a continuation view:

```text
Last active task:
Memory V2

Completed:
- scoped memory schema proposal
- workspace model

Current:
- context retrieval design

Next:
- implement migrations
- add tests

Recent decision:
- workspace memory must not leak globally

Blocked:
- none
```

Then:

```text
"Continue from context retrieval design?"
```

If confidence is high, the agent may simply continue and show what it resumed.

---

# 32. Agent-Facing Implementation Instructions

The coding agent receiving this document MUST follow this process.

## 32.1 Phase 0 — Repository audit

Before coding:

1. inspect current `main`,
2. read `AGENTS.md`,
3. read relevant docs,
4. inspect current DB schema/migrations,
5. inspect memory repositories,
6. inspect skill repositories,
7. inspect workflow executor,
8. inspect chat API,
9. inspect UI routing/navigation,
10. inspect test conventions.

Produce an internal implementation map.

Do not assume this spec's suggested filenames exactly match the repository.

## 32.2 No rewrite rule

Do NOT:

- replace working subsystems unnecessarily,
- create a parallel memory system,
- create a second workflow engine,
- create a second agent runtime,
- bypass existing MCP abstractions,
- duplicate repositories already present.

Extend current abstractions.

## 32.3 Prefer vertical slices

Do not build 20 empty database tables first.

Implement complete vertical slices.

Example:

```text
Workspace schema
→ repository
→ API/service
→ attach chat
→ context behavior
→ UI
→ tests
```

Then proceed.

## 32.4 Feature flags

Large V2 changes SHOULD be feature flagged where practical.

Examples:

```text
IRIS_WORKSPACES_V2
IRIS_LEARNING_V2
IRIS_AUTOMATION_V2
```

Use the repository's existing configuration style.

Remove stale flags once stable.

---

# 33. Recommended Delivery Phases

## Phase 1 — Workspace Foundation

### Requirements

- Workspace entity.
- Workspace CRUD.
- Workspace selector.
- Thread/workspace association.
- Workspace instructions.
- Workspace context injection.
- Archive workspace.
- Backward compatibility.
- Tests.

### Done when

User can create `IRIS-OS` workspace, open a chat in it, and IRIS consistently receives workspace instructions without affecting chats outside it.

---

## Phase 2 — Scoped Memory V2

### Requirements

- expanded memory kinds,
- memory scope,
- temporal fields,
- migration,
- scoped retrieval,
- scoped dedup/conflict logic,
- memory UI updates,
- tests for isolation.

### Critical test

```text
Workspace A memory:
"use npm"

Workspace B memory:
"use pnpm"

Query inside Workspace A
→ never retrieve Workspace B preference.
```

---

## Phase 3 — Task / Work Ledger

### Requirements

- task model,
- task CRUD,
- task activity,
- task resource refs,
- active-task context,
- task checkpoints,
- task UI,
- continuation flow.

### Done when

User can stop a task, return days later, and continue with task state without manually finding the previous conversation.

---

## Phase 4 — Activity Events + Learning Engine

### Requirements

- normalized activity events,
- asynchronous observations,
- statement extraction,
- behavior signals,
- learning candidates,
- feedback,
- configurable confidence policy.

### Done when

Repeated user behavior can create a reviewable memory candidate.

---

## Phase 5 — Learning Inbox

### Requirements

- suggestions,
- confidence,
- evidence,
- edit,
- confirm,
- ignore,
- conflict resolution,
- scope changes,
- settings.

### Done when

User can understand what IRIS learned and control it.

---

## Phase 6 — Memory → Skill

### Requirements

- procedure memory,
- pattern threshold,
- skill candidate,
- skill generation through existing Skill system,
- provenance,
- skill feedback,
- versioning.

### Done when

A repeated user procedure can be converted into a working existing-format IRIS Skill.

---

## Phase 7 — Automation Foundation

### Requirements

- automation entity,
- schedule trigger,
- durable scheduler adapter,
- automation runs,
- approval policy,
- run history,
- workflow/agent/skill target.

### Done when

A workflow can execute at a scheduled time independently of an open chat.

---

## Phase 8 — Learning → Automation

### Requirements

- repeated-run detection,
- automation candidate,
- recommendation UI,
- reject/suppress behavior,
- create automation from candidate.

### Done when

IRIS can recognize repeated timed work and safely suggest automation.

---

## Phase 9 — Agent Delegation

### Requirements

- delegate tool/runtime primitive,
- subagent isolation,
- run hierarchy,
- status UI,
- cancellation,
- structured result,
- permission inheritance.

### Done when

A parent agent can safely delegate bounded tasks to specialist agents and synthesize results.

---

## Phase 10 — OS Dashboard + Polish

### Requirements

- home dashboard,
- active work,
- learning summary,
- automation status,
- attention items,
- recent workspaces,
- continuation shortcuts.

### Done when

Opening IRIS feels like opening a work operating environment, not merely a chat application.

---

# 34. Priority Matrix

| Feature | Priority | Complexity | Product Impact |
|---|---:|---:|---:|
| Workspace primitive | P0 | Medium | Very High |
| Scoped memory | P0 | Medium | Very High |
| Expanded memory hierarchy | P0 | Medium | High |
| Task ledger | P0 | Medium | Very High |
| Learning events | P0 | Medium | Very High |
| Learning Inbox | P1 | Medium | High |
| Memory → Skill | P1 | High | Very High |
| Automation foundation | P1 | High | Very High |
| Workflow triggers | P1 | High | Very High |
| Agent delegation | P1 | High | High |
| OS Dashboard | P2 | Medium | High |
| Persistent compute environment | P2/P3 | Very High | Very High |
| Collaboration | P3 | High | High |

---

# 35. Non-Goals for Initial V2

Do not block V2 on:

- replacing the device operating system,
- building a full cloud IDE,
- permanent autonomous browser sessions,
- dozens of SaaS integrations,
- multi-tenant enterprise RBAC,
- autonomous external actions without permission policy,
- fully automatic self-modifying agents,
- storing every interaction as permanent memory,
- replacing existing skills/workflows/MCP.

V2 foundation should make these possible later.

---

# 36. Testing Requirements

## 36.1 Unit tests

At minimum:

```text
scope resolution
memory migration
memory relation classification
memory ranking
learning confidence
pattern threshold
task status transitions
automation schedule calculation
permission inheritance
```

## 36.2 Integration tests

```text
chat → workspace context
chat → scoped memory
message → learning observation
candidate → memory confirmation
procedure → skill candidate
automation → workflow run
delegate → child agent → parent result
```

## 36.3 E2E tests

Critical user stories:

```text
create workspace
chat within workspace
switch workspace
verify isolation

create task
continue task

review learning candidate
confirm memory
edit memory

create learned skill

schedule workflow
inspect run history
```

## 36.4 Migration tests

Use existing production-like schema snapshots if repository conventions support them.

Must test existing memory rows.

---

# 37. Performance Requirements

Learning must be asynchronous when possible.

Target request path:

```text
chat request
→ context retrieval
→ execution
→ stream result
```

Post-response work:

```text
index
learning review
pattern analysis
candidate creation
```

must not unnecessarily delay the user response.

Memory/context retrieval should use:

- scope filtering before expensive semantic ranking,
- bounded result counts,
- token budgeting,
- indexes,
- caching only where correctness permits.

---

# 38. Failure Handling

## Memory service unavailable

Chat should continue without memory where safe.

Expose degraded mode in logs/telemetry, not alarming user messaging unless material.

## Learning job fails

Do not fail chat.

Retry according to queue policy.

## Automation fails

Record run failure and surface actionable error.

## Delegated agent fails

Parent receives structured failure and can retry, choose another plan, or report status.

## External connection unavailable

Do not hallucinate access.

Mark resource disconnected.

---

# 39. Observability

Every V2 subsystem should provide structured logs.

Recommended dimensions:

```text
userId       # hash/redact if logging policy requires
workspaceId
taskId
threadId
runId
parentRunId
agentId
workflowId
automationId
memoryId
candidateId
```

Track latency:

```text
context planning
memory recall
agent execution
tool execution
workflow
learning extraction
```

Never log secrets.

---

# 40. Example End-to-End Experience

## Day 1

User creates:

```text
Workspace: IRIS-OS
```

Adds repository and instructions.

User discusses memory architecture.

IRIS learns:

```text
Goal:
Make IRIS learn how the user works.

Decision:
Memory should be scoped by workspace.

Preference:
Use pnpm in IRIS-OS.
```

## Day 7

User:

```text
"Continue IRIS memory."
```

IRIS finds:

```text
Task: Scoped Memory V2
Status: in progress
Next: add isolation tests
```

and continues.

## Day 20

IRIS observes repeated development routine:

```text
inspect architecture
implement
run tests
review diff
update docs
```

IRIS proposes:

```text
Create skill: iris-feature-implementation?
```

User confirms.

## Day 40

Skill runs repeatedly.

IRIS notices every Friday the user runs:

```text
review open tasks
review PRs
summarize progress
create next-week plan
```

IRIS proposes a Friday Review workflow.

## Day 60

User accepts and schedules it.

Now IRIS is not merely remembering the user.

It has learned part of the user's operating system for work.

---

# 41. Architectural Invariants

These must remain true.

## Invariant 1

```text
Current explicit user instruction > old memory.
```

## Invariant 2

```text
Memory is data, not authority.
```

## Invariant 3

```text
Workspace-specific memory must not leak across workspace scope.
```

## Invariant 4

```text
Child/subagent permissions cannot silently exceed parent execution permissions.
```

## Invariant 5

```text
Learning never directly grants tool permissions.
```

## Invariant 6

```text
Automation never bypasses approval policy.
```

## Invariant 7

```text
Every inferred durable learning should have evidence/provenance.
```

## Invariant 8

```text
Chat history is not task state.
```

## Invariant 9

```text
Skill is procedural capability.
Workflow is orchestration.
Automation is trigger + execution binding.
```

## Invariant 10

```text
Do not store everything.
Learn selectively.
```

---

# 42. Definitions

## Memory

Durable knowledge likely to improve future reasoning or action.

## Observation

A piece of evidence from user activity that may or may not become memory.

## Learning Candidate

An inferred item awaiting policy or user decision.

## Skill

Reusable procedural instructions/capability.

## Workflow

Explicit multi-step orchestration.

## Automation

A trigger bound to a skill, agent, or workflow.

## Task

Persistent work state with status, next action, activity, and outputs.

## Workspace

Durable scope containing related work, context, resources, memory, and capabilities.

## Activity Event

Normalized record of an observable action/outcome.

## Decision

A choice plus enough context/rationale to understand why it was made.

---

# 43. Suggested Product Positioning

Current positioning can evolve from:

> The open operating system for AI agents, tools, and workflows.

toward:

> **The personal AI operating system that learns how you work.**

Supporting idea:

> Bring your projects, tools, knowledge, and workflows into one AI workspace. IRIS remembers context, learns recurring patterns, turns them into reusable capabilities, and helps automate the work you repeat.

Do not position IRIS merely as:

```text
multi-model chat
ChatGPT alternative
MCP client
agent builder
workflow builder
```

Those are capabilities.

The differentiated product is the **learning work layer** connecting them.

---

# 44. Agent Completion Checklist

Before declaring each V2 phase done, verify:

- [ ] Existing behavior remains backward compatible.
- [ ] Database migration is reversible or rollback is documented.
- [ ] Multi-user ownership boundaries are enforced.
- [ ] Workspace scoping is enforced server-side.
- [ ] Memory scoping is enforced server-side.
- [ ] Retrieval respects scope.
- [ ] Dedup/conflict logic respects scope.
- [ ] Learning has provenance/evidence.
- [ ] Sensitive information is filtered.
- [ ] Tool permissions are enforced server-side.
- [ ] User can inspect meaningful autonomous actions.
- [ ] User can disable/remove learned items.
- [ ] Tests cover success and failure paths.
- [ ] UI has loading/empty/error states.
- [ ] No private chain-of-thought is exposed.
- [ ] Logs contain no secrets.
- [ ] Long-running operations have status/cancellation where applicable.
- [ ] Documentation is updated.

---

# 45. First Implementation Target

The recommended first major PR/series is:

```text
IRIS V2 Foundation
```

Scope:

1. Workspace model + UI.
2. Associate threads with workspace.
3. Workspace instructions.
4. Add memory scope.
5. Migrate existing memory to global scope.
6. Scope-aware memory retrieval.
7. Scope-aware conflict/dedup.
8. Basic workspace Memory view.
9. Tests.

Do NOT implement automation or delegation in the first PR.

The first milestone should prove this core invariant:

> **IRIS can know something inside one workspace without incorrectly treating it as universal user knowledge.**

After this, implement the Task Ledger.

Then implement Learning Events.

This ordering minimizes architecture churn.

---

# 46. Recommended PR Breakdown

Suggested PR sequence:

```text
PR 1  — Workspace domain + persistence
PR 2  — Workspace selector + routing
PR 3  — Thread workspace association
PR 4  — Workspace runtime context
PR 5  — Memory scope schema + migration
PR 6  — Scoped memory retrieval + tests
PR 7  — Memory hierarchy types
PR 8  — Workspace memory UI
PR 9  — Task domain + persistence
PR 10 — Task UI + continuation
PR 11 — Activity event foundation
PR 12 — Learning observation pipeline
PR 13 — Learning candidates + Inbox
PR 14 — Behavioral learning signals
PR 15 — Procedure memory
PR 16 — Learned Skill candidate
PR 17 — Skill feedback/evolution
PR 18 — Automation domain
PR 19 — Durable schedule runner
PR 20 — Workflow/Skill/Agent automation targets
PR 21 — Learning → automation proposals
PR 22 — Delegation runtime
PR 23 — Delegation UI
PR 24 — OS dashboard
```

Combine/split based on repository conventions and review size.

Each PR should remain independently testable.

---

# 47. Architectural Decision Guidance for Coding Agents

When implementation details are unclear, use this priority order:

```text
1. Security and user ownership
2. Backward compatibility
3. Existing IRIS architectural conventions
4. Explicit scope
5. Composability
6. Auditability
7. Performance
8. UI convenience
```

When this specification conflicts with actual current implementation details:

> Preserve the intent of this specification while adapting to the repository's real architecture.

Do not force a suggested pseudocode shape when a better existing abstraction already exists.

---

# 48. Final North-Star Test

After IRIS V2 has matured, this scenario should work naturally:

```text
User opens IRIS after several months.

User:
"Continue the release preparation."

IRIS understands:
- which workspace,
- which release,
- current task status,
- previous decisions,
- relevant repository/resources,
- preferred development process,
- which specialist agents are useful,
- which reusable skills exist,
- what requires approval,
- what remains blocked.

IRIS delegates analysis,
runs approved tools,
updates the task,
creates artifacts,
and records the outcome.

Afterward IRIS notices that part of the process was repeated again.

It proposes improving a skill or automating the repeatable portion.

The next release requires less explanation and less manual work.
```

If IRIS reaches this behavior, the product has moved beyond:

```text
chatbot with memory
```

into:

```text
a learning operating layer for the user's work.
```

---

# 49. Source-of-Truth Notes

This document is a V2 design specification, not a statement that every proposed entity already exists.

Implementation agents must inspect the latest repository before changing code.

Primary repository:

https://github.com/dwickyfp/iris-os

Important baseline references:

```text
README.md
src/app/api/chat/route.ts
src/types/memory.ts
src/types/skill.ts
src/lib/ai/memory/
src/lib/ai/agent/
src/lib/ai/workflow/
src/lib/ai/mcp/
```

The existing IRIS architecture should remain the foundation.

---

# 50. Final Directive to Implementation Agent

Do not optimize IRIS V2 for the number of features.

Optimize it for this compounding loop:

```text
UNDERSTAND
    ↓
REMEMBER
    ↓
CONTINUE
    ↓
ACT
    ↓
OBSERVE
    ↓
LEARN
    ↓
REUSE
    ↓
AUTOMATE
```

Every major V2 implementation decision should answer:

> **Will this help IRIS understand the user's work better, reduce repeated explanation, reduce repeated manual work, and remain under the user's control?**

If the answer is no, it is probably not a V2 priority.
