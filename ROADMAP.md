# IRIS-OS V2 — Roadmap Lanjutan

Dokumen ini adalah rencana kerja lanjutan setelah implementasi fondasi IRIS-OS
V2 pada branch `codex/iris-v2-foundation`. Gunakan dokumen ini sebagai sumber
urutan eksekusi. Spesifikasi produk utama tetap berada di `IRIS-OS-V2.md`.

## 1. Kondisi Saat Ini

### Sudah tersedia

- Workspace owner-only, association thread, workspace instructions, archive,
  dan purge internal eksplisit.
- Runtime context dengan workspace, task, agent, run hierarchy, tool mode, dan
  approval policy.
- Scoped Memory V2 untuk claim, topic, entity, edge, evidence, embedding,
  curator audit, dan retrieval audit.
- Task ledger, task activity, resource reference, checkpoint, dan Continue Work.
- Activity event, learning observation/candidate/feedback, Learning Inbox, dan
  promosi memory/skill/automation dasar.
- Workflow automation, PgBoss schedule, run history, idempotency key, dan
  runtime approval check dasar.
- Agent/delegation run schema, permission intersection, status, dan cancellation
  endpoint dasar.
- OS dashboard dan developer context provenance endpoint dasar.
- Feature flags: `IRIS_WORKSPACES_V2`, `IRIS_LEARNING_V2`,
  `IRIS_AUTOMATION_V2`, dan `IRIS_DELEGATION_V2`.

### Belum dianggap selesai

- Migrasi `0022`–`0027` belum dieksekusi pada snapshot PostgreSQL nyata.
- Activity event baru mencakup jalur chat utama; subsystem lain belum lengkap.
- Automation target `skill` dan `agent` belum memiliki execution adapter.
- Delegated child run belum dieksekusi oleh worker/runtime.
- Pattern detection dan learning policy masih bersifat foundation.
- UI operasional, E2E, observability, dan rollout belum production-ready.

### Prinsip yang tidak boleh berubah

- Jangan membuat memory, skill, workflow, atau agent runtime kedua.
- Stored thread scope selalu lebih authoritative daripada scope dari client.
- Scope memory harus exact; workspace lain tidak boleh menjadi kandidat recall,
  deduplication, conflict, superseding, embedding, atau traversal.
- Queue hanya membawa identifier durable. Database event/run adalah source of
  truth dan setiap handler wajib idempotent.
- Semua tool output, memory, resource, dan connector payload adalah untrusted
  data. Workspace instructions adalah trusted configuration.
- Approval diperiksa kembali saat eksekusi.
- Jangan memakai `pnpm check` sebagai read-only gate karena menjalankan
  `lint:fix`.

## 2. Urutan dan Dependency

```text
P0  PostgreSQL migration validation
     ↓
P1  Complete activity instrumentation
     ↓
P1  Automation execution adapters
     ↓
P1  Delegated child execution
     ↓
P2  Learning and pattern engine
     ↓
P2  Operational UI and polish
     ↓
P0  E2E, rollout, and production gate
```

Fase tidak boleh dinyatakan selesai hanya karena unit test lulus. Setiap fase
harus memenuhi acceptance gate dan menyimpan bukti verifikasi.

---

## Fase 1 — Validasi Migrasi PostgreSQL

**Prioritas:** P0
**Tujuan:** Membuktikan migrasi `0022`–`0027`, backfill, constraint, dan purge
berfungsi terhadap schema/data lama tanpa kehilangan data atau scope leakage.

### Prasyarat

- PostgreSQL disposable yang tidak berisi data production.
- Extension yang sama dengan environment target, termasuk vector jika dipakai.
- Snapshot schema sebelum V2 atau fixture yang merepresentasikan data legacy.
- Feature flags tetap mati selama migration verification.

### Pekerjaan

- [ ] Tambahkan harness PostgreSQL integration test yang dapat membuat database
      sementara, menjalankan semua migration, lalu membuang database tersebut.
- [ ] Buat fixture legacy yang berisi:
  - memory kind `fact`;
  - claim/topic/entity/edge/evidence/embedding lama;
  - global chat thread tanpa workspace;
  - conflict dan retrieval audit;
  - minimal dua user untuk ownership test.
- [ ] Jalankan migration `0022_scoped_memory_v2.sql` dan buktikan:
  - seluruh `fact` berubah menjadi `semantic`;
  - legacy rows mendapatkan `scope_type = 'global'` dan `scope_id = NULL`;
  - edge, evidence, embedding, dan audit tetap merujuk data yang valid;
  - exact-scope unique index bekerja untuk global `NULL` dan non-global UUID;
  - cross-scope edge ditolak.
- [ ] Jalankan migration task, activity/learning, automation/delegation,
      learned-skill, dan workspace purge secara berurutan.
- [ ] Uji migration pada database kosong dan database berisi snapshot legacy.
- [ ] Uji forward-fix untuk migration yang tidak aman di-rollback.
- [ ] Jalankan integrity queries setelah migration:
  - orphan scoped rows;
  - invalid scope pair;
  - duplicate exact-scope nodes;
  - cross-user association;
  - cross-scope memory edge;
  - stale thread workspace/task reference.
- [ ] Uji workspace purge dengan workspace memory dan task-scoped memory.
- [ ] Dokumentasikan runtime, durasi, row count sebelum/sesudah, dan hasil
      integrity queries.

### File sasaran

- `src/lib/db/migrations/pg/0022_scoped_memory_v2.sql`
- `src/lib/db/migrations/pg/0023_task_ledger.sql`
- `src/lib/db/migrations/pg/0024_activity_learning.sql`
- `src/lib/db/migrations/pg/0025_automation_delegation.sql`
- `src/lib/db/migrations/pg/0026_learned_skills.sql`
- `src/lib/db/migrations/pg/0027_workspace_purge.sql`
- `src/lib/db/migrations/pg/meta/_journal.json`
- `tests/integration/db/` — fixture dan migration tests baru
- `scripts/` — integrity checker bila query cukup besar

### Test wajib

- Migration dari schema kosong.
- Migration dari snapshot legacy.
- Global `NULLS NOT DISTINCT` uniqueness.
- Dua workspace dengan content memory identik dan bertentangan.
- Embedding upsert untuk global/workspace/task/agent scope.
- Workspace cascade purge tidak meninggalkan polymorphic scoped rows.
- User A tidak dapat merujuk workspace/task/agent milik user B.

### Acceptance gate

- [ ] Tidak ada orphan, duplicate, atau cross-scope edge setelah migration.
- [ ] Semua legacy memory dapat diretrieve sebagai global memory.
- [ ] Row count loss dijelaskan dan hanya berasal dari transformasi yang
      disengaja.
- [ ] Migration test dapat diulang dari awal tanpa langkah manual.
- [ ] Forward-fix procedure didokumentasikan.

### Rollback/recovery

- Matikan seluruh feature flag V2 untuk behavioral rollback.
- Simpan snapshot database sebelum migration.
- Untuk perubahan taxonomy/scope gunakan forward-fix; jangan mengembalikan data
  ke schema ambigu.
- Jangan menjalankan purge test pada database non-disposable.

### Commit yang disarankan

1. `test: add disposable postgres migration harness`
2. `test: verify scoped memory legacy backfill`
3. `docs: document IRIS V2 migration recovery`

---

## Fase 2 — Lengkapi Activity Event

**Prioritas:** P1
**Dependency:** Fase 1
**Tujuan:** Semua perubahan penting menghasilkan event tersanitasi dan durable
tanpa menambah blocking latency pada chat/tool/workflow execution.

### Event minimum

- Chat: started, completed, failed, cancelled, correction.
- Tool: requested, approval requested, approved/rejected, started, completed,
  failed, cancelled.
- Workflow: started, node completed/failed, completed, cancelled.
- Task: created, assigned, status changed, checkpointed, continued, completed.
- Skill: created, executed, corrected, version proposed, approved/rejected.
- Learning: observation created, candidate created/reviewed/suppressed/promoted.
- Automation: triggered, approval blocked, started, retried, completed, failed,
  cancelled, missed.
- Delegation: requested, child queued/started/completed/failed/cancelled/timed out.
- Artifact/resource: created, attached, detached, archived.

### Pekerjaan

- [ ] Definisikan typed event registry dan payload schema per event type.
- [ ] Pusatkan sanitization, payload size limit, secret filtering, dan allowed
      correlation fields.
- [ ] Tambahkan helper transaction-aware agar perubahan domain dan event dapat
      ditulis atomically saat diperlukan.
- [ ] Instrumentasikan setiap subsystem tanpa memasukkan chain-of-thought,
      credential, full attachment, atau raw connector payload.
- [ ] Queue hanya mengirim `{ eventId }`.
- [ ] Tambahkan event claim/idempotency agar dua worker tidak memproses event
      yang sama bersamaan.
- [ ] Terapkan retry dengan capped backoff dan dead-letter/failed state yang
      observable.
- [ ] Sweep hanya mengambil unprocessed/stale event secara bounded batch.
- [ ] Tambahkan retention policy untuk payload dan audit metadata.
- [ ] Tambahkan metrics: queue lag, processing duration, retry count, failure
      count, dan oldest unprocessed event.

### File sasaran

- `src/types/activity.ts`
- `src/lib/activity/sanitize.ts`
- `src/lib/activity/service.ts`
- `src/lib/activity/queue.ts`
- `scripts/workers/activity-worker.ts`
- `scripts/iris-worker.ts`
- `src/app/api/chat/route.ts`
- task, workflow, skill, automation, dan delegation service/route terkait

### Test wajib

- Unit payload schema dan sanitizer, termasuk secret/token redaction.
- Duplicate queue delivery menghasilkan satu observation/candidate.
- Worker crash setelah claim dapat dipulihkan oleh sweep.
- Chat stream selesai tanpa menunggu learning worker.
- Failure/cancellation menghasilkan status dan event yang benar.
- Event user A tidak dapat diproses ke artifact user B.

### Acceptance gate

- [ ] Setiap event minimum memiliki producer dan test.
- [ ] Event payload sanitized dan memiliki batas ukuran.
- [ ] P95 chat latency tidak bertambah secara material karena learning.
- [ ] Retry tidak menghasilkan duplicate candidate/artifact.
- [ ] Dashboard/debug view dapat menunjukkan backlog dan failure.

### Rollback/recovery

- Matikan `IRIS_LEARNING_V2` untuk menghentikan consumer learning.
- Producer event tetap boleh aktif sebagai audit trail jika aman.
- Pause PgBoss queues saat terjadi runaway retry, lalu jalankan bounded sweep.

### Commit yang disarankan

1. `feat: add typed IRIS activity registry`
2. `feat: instrument task workflow and tool events`
3. `feat: add idempotent activity retry and metrics`

---

## Fase 3 — Selesaikan Automation Executor

**Prioritas:** P1
**Dependency:** Fase 2
**Tujuan:** Workflow, skill, dan agent memakai satu execution adapter contract,
runtime yang sudah ada, dan lifecycle run yang konsisten.

### Kontrak adapter

```ts
type AutomationTarget = "workflow" | "skill" | "agent";

type AutomationExecutionResult =
  | { status: "succeeded"; output: Record<string, unknown> }
  | { status: "failed"; errorCode: string; message: string; retryable: boolean }
  | { status: "cancelled"; message?: string };
```

Adapter menerima user, scope, target, sanitized input, approval grant, run ID,
timeout, dan cancellation signal. Adapter tidak boleh melewati repository access
check atau membuat runtime paralel.

### Pekerjaan

- [ ] Tulis failing contract tests untuk workflow/skill/agent target.
- [ ] Ekstrak workflow execution dari worker ke execution adapter.
- [ ] Hubungkan skill adapter ke existing Skill repository/runtime dan
      `allowedTools`.
- [ ] Hubungkan agent adapter ke existing agent runtime dengan explicit context.
- [ ] Validasi target ownership setiap run, bukan hanya saat konfigurasi.
- [ ] Hitung effective tools sebagai intersection target config dan approval.
- [ ] Tambahkan status `awaiting_approval` atau model approval durable yang tidak
      melaporkan run sebagai failed hanya karena menunggu user.
- [ ] Implement retry policy per error class dan attempt history.
- [ ] Implement cancellation signal dan timeout propagation.
- [ ] Implement missed-run policy `skip`, `run_once`, atau kebijakan final yang
      dikunci di schema/API.
- [ ] Pastikan unique run key mencegah scheduled/manual duplicate execution.
- [ ] Simpan structured result yang telah disanitasi dan dibatasi ukurannya.
- [ ] Tambahkan refresh/reconciliation untuk schedule yang berubah atau di-pause.

### File sasaran

- `src/lib/automation/execution-adapter.ts` — baru
- `src/lib/automation/execution-adapter.test.ts` — baru
- `src/lib/automation/idempotency.ts`
- `src/lib/automation/queue.ts`
- `scripts/workers/automation-worker.ts`
- `src/app/api/automations/`
- existing workflow, skill, dan agent runtime/repository

### Test wajib

- Workflow/skill/agent happy path dan inaccessible target.
- Destructive tool tanpa approval tidak dieksekusi.
- Approval yang sudah dicabut ditolak saat run dimulai.
- Duplicate delivery menghasilkan satu AutomationRun.
- Retryable dan non-retryable failure dibedakan.
- Cancellation dan timeout tidak berakhir sebagai succeeded.
- Timezone/DST dan missed schedule behavior.

### Acceptance gate

- [ ] Tidak ada target yang dilaporkan succeeded tanpa runtime execution.
- [ ] Ketiga adapter menggunakan runtime yang sudah ada.
- [ ] Permission dan ownership diperiksa saat execution.
- [ ] Retry, timeout, cancellation, dan approval dapat dilihat di run history.
- [ ] Schedule restart/redeploy tidak menghasilkan duplicate run.

### Rollback/recovery

- Matikan `IRIS_AUTOMATION_V2` dan pause automation queues.
- Existing workflows/skills/agents tetap dapat dijalankan manual.
- Run yang sudah started diselesaikan atau dicancel secara eksplisit; jangan
  menghapus history.

### Commit yang disarankan

1. `test: define automation execution adapter contract`
2. `feat: execute workflow skill and agent automation targets`
3. `feat: add durable automation approval retry and cancellation`

---

## Fase 4 — Selesaikan Agent Delegation

**Prioritas:** P1
**Dependency:** Fase 3
**Tujuan:** Parent agent dapat mendelegasikan bounded objective kepada child
agent, dengan permission terisolasi, lifecycle durable, dan structured result.

### Pekerjaan

- [ ] Tambahkan delegation tool ke existing agent tool registry.
- [ ] Input tool hanya menerima objective, child agent ID, bounded context,
      timeout, dan optional result schema; jangan menerima caller-controlled
      tool permission arrays.
- [ ] Validasi parent run, child ownership, workspace/task scope, dan depth limit.
- [ ] Hitung effective child tools sebagai intersection:
  - parent effective tools;
  - child configured tools/skills;
  - durable user approval;
  - global security policy.
- [ ] Buat PgBoss queue yang hanya membawa `childRunId`.
- [ ] Worker memuat authoritative run/context dari database.
- [ ] Jalankan child melalui existing agent runtime/execution adapter.
- [ ] Terapkan max depth, max children, max parallel children, timeout, dan token
      budget.
- [ ] Propagasikan parent cancellation ke seluruh active child.
- [ ] Simpan structured result/failure dan observable actions tanpa
      chain-of-thought.
- [ ] Parent menunggu bounded child result lalu melakukan synthesis.
- [ ] Tangani partial failure: parent dapat memakai successful child outputs dan
      melihat failure lainnya.
- [ ] Tambahkan stale-run sweeper untuk queued/running child yang orphaned.

### File sasaran

- `src/lib/ai/agent/delegation-tool.ts` — baru
- `src/lib/ai/agent/delegation-policy.ts`
- `src/lib/ai/agent/runtime-context.ts`
- `scripts/workers/delegation-worker.ts` — baru
- `scripts/iris-worker.ts`
- `src/app/api/agent-runs/[id]/delegate/route.ts`
- `src/app/api/agent-runs/[id]/route.ts`
- `src/lib/db/pg/schema.pg.ts` bila lifecycle field perlu ditambah

### Test wajib

- Permission intersection tidak dapat diperlebar oleh JSON client.
- Cross-user/workspace child delegation ditolak.
- Max depth/children/parallel/timeout ditegakkan.
- Parent cancellation membatalkan child.
- Child success, failure, timeout, cancellation, dan partial failure.
- Parent synthesis hanya menerima structured/observable result.
- Duplicate child queue delivery tidak menjalankan child dua kali.

### Acceptance gate

- [ ] Delegation menghasilkan child execution nyata dan structured result.
- [ ] Child tidak pernah mendapat permission lebih luas dari parent/config/user.
- [ ] Semua terminal state akurat dan memiliki completed timestamp.
- [ ] Tidak ada chain-of-thought dalam API/UI/audit.
- [ ] Parallel delegation tetap bounded dan dapat dibatalkan.

### Rollback/recovery

- Matikan `IRIS_DELEGATION_V2` untuk menghilangkan delegation tool.
- Cancel active child runs sebelum menghentikan worker.
- Pertahankan run history untuk audit.

### Commit yang disarankan

1. `feat: add bounded delegation tool contract`
2. `feat: execute delegated child agent runs`
3. `feat: add delegation cancellation timeout and synthesis`

---

## Fase 5 — Perluas Learning dan Pattern Engine

**Prioritas:** P2
**Dependency:** Fase 2–4
**Tujuan:** Mengubah event menjadi observation dan candidate berkualitas dengan
evidence, confidence, promotion, conflict, versioning, dan suppression policy.

### Pekerjaan

- [ ] Pisahkan pipeline menjadi extractor, scope resolver, candidate generator,
      conflict classifier, promotion policy, dan pattern detector.
- [ ] Gunakan typed activity events sebagai input utama.
- [ ] Gabungkan evidence berulang tanpa membuat duplicate candidate.
- [ ] Definisikan confidence berdasarkan jumlah evidence, recency, consistency,
      correction/rejection, dan source reliability.
- [ ] Terapkan promotion threshold per candidate type:
  - memory dapat auto-promote hanya untuk kategori aman yang dikunci;
  - skill/automation selalu reviewable pada fase awal;
  - sensitive/ambiguous learning selalu memerlukan review atau di-drop.
- [ ] Deteksi conflict hanya pada exact scope.
- [ ] Rejection menghasilkan stable suppression key dan retention policy.
- [ ] Edit/change-scope menjaga evidence/provenance history.
- [ ] Procedure memory menghasilkan versioned skill proposal.
- [ ] Koreksi terhadap learned skill menghasilkan new version proposal, bukan
      silent rewrite.
- [ ] Deteksi pola waktu/frekuensi dari event history menjadi automation
      candidate dengan preview schedule dan target binding.
- [ ] Tambahkan privacy settings: learning on/off, allowed scopes/categories,
      retention, dan sensitive-data policy.
- [ ] Tambahkan stale `processing` recovery dan promotion compensation.

### File sasaran

- `src/lib/learning/` — pipeline modules baru
- `scripts/workers/activity-worker.ts`
- `src/app/api/learning/candidates/`
- `src/components/learning/learning-inbox.tsx`
- `src/lib/ai/memory/curator.ts`
- existing Skill repository/runtime
- automation candidate creation flow

### Test wajib

- Message/event → observation → candidate.
- Repeated evidence menaikkan confidence tanpa duplicate.
- Opposing workspace facts tidak menjadi conflict lintas scope.
- Confirm/edit/change-scope/ignore dan concurrent confirm.
- Suppression mencegah saran yang sama muncul terus.
- Procedure → learned Skill provenance/version.
- Temporal pattern → automation candidate → confirmed Automation.
- Sensitive payload tidak menjadi candidate.

### Acceptance gate

- [ ] Setiap candidate memiliki evidence yang dapat diinspeksi.
- [ ] Promotion idempotent dan tidak meninggalkan untracked artifact.
- [ ] Conflict/suppression bekerja exact scope.
- [ ] Learned skill selalu reviewable dan versioned.
- [ ] Learning worker tidak menambah blocking latency pada producer.

### Rollback/recovery

- Matikan `IRIS_LEARNING_V2` dan pause consumer.
- Jangan hapus observation/event saat rollback; pertahankan audit sesuai
  retention policy.
- Artifact hasil promotion tetap mengikuti deletion/versioning domain asal.

### Commit yang disarankan

1. `feat: add evidence-based learning pipeline`
2. `feat: add scoped conflict promotion and suppression policies`
3. `feat: detect learned skills and automation patterns`

---

## Fase 6 — Operational UI dan Polish

**Prioritas:** P2
**Dependency:** Fase 3–5
**Tujuan:** Semua asynchronous work dapat dipahami, direview, dilanjutkan, dan
dikendalikan user tanpa mengekspos implementation reasoning.

### Pekerjaan UI

- [ ] OS Dashboard:
  - active work dan Continue Work;
  - attention items;
  - pending learning candidates;
  - failed/awaiting approval automation runs;
  - active delegated children;
  - recent workspaces dan activity.
- [ ] Automation:
  - create/edit/pause/archive;
  - target selector dan input preview;
  - cron/timezone/missed-run preview;
  - approval action;
  - run history, attempt, retry, cancel, structured output/error.
- [ ] Delegation:
  - parent/child hierarchy;
  - status, elapsed time, checkpoints, observable actions/tool calls;
  - cancel child/branch;
  - structured result/failure.
- [ ] Learning Inbox:
  - evidence inspector;
  - conflict comparison;
  - edit/change scope;
  - suppression/history/privacy settings;
  - learned skill/automation preview.
- [ ] Workspace:
  - archive and permanent purge flow;
  - literal confirmation and cascade summary;
  - explain that external resources are not deleted.
- [ ] Developer mode:
  - context precedence/provenance;
  - trusted vs untrusted sources;
  - token allocation/truncation;
  - event/run correlation IDs.
- [ ] Tambahkan loading, empty, error, retry, permission-denied, dan feature-off
      states.
- [ ] Pastikan mobile layout, keyboard navigation, focus management, contrast,
      dan screen-reader labels.

### File sasaran

- `src/app/(chat)/os/`
- `src/app/(chat)/learning/`
- automation dan workspace pages baru/terkait
- `src/components/os/`
- `src/components/learning/`
- components automation/delegation baru
- `src/components/layouts/app-sidebar-menus.tsx`
- `src/app/api/debug/context/route.ts`

### Test wajib

- Component tests untuk terminal/loading/error/permission states.
- Selector scope tidak dapat mengubah authoritative existing thread scope.
- Approval/retry/cancel optimistic update melakukan rollback saat API gagal.
- Accessibility scan pada dashboard, learning, automation, delegation.
- Screenshot/visual regression untuk desktop dan mobile critical flows.

### Acceptance gate

- [ ] User dapat mengetahui apa yang berjalan, perlu perhatian, gagal, dan dapat
      dilanjutkan dari dashboard.
- [ ] Setiap destructive action memiliki explicit confirmation.
- [ ] UI tidak menampilkan chain-of-thought.
- [ ] Semua fitur memiliki feature-off state yang aman.
- [ ] Critical flows memenuhi keyboard dan screen-reader baseline.

### Rollback/recovery

- UI mengikuti server feature flags; hidden UI bukan security boundary.
- Jika endpoint belum stabil, sembunyikan entry point tanpa menghapus run data.

### Commit yang disarankan

1. `feat: add operational automation and delegation views`
2. `feat: expand learning evidence and privacy controls`
3. `feat: polish OS dashboard accessibility and error states`

---

## Fase 7 — E2E, Rollout, dan Production Gate

**Prioritas:** P0
**Dependency:** Semua fase sebelumnya
**Tujuan:** Membuktikan vertical slices bekerja bersama, dapat diobservasi, dan
dapat diaktifkan bertahap tanpa merusak legacy behavior.

### E2E wajib

- [ ] Create/switch/archive workspace.
- [ ] Workspace instructions hanya memengaruhi associated thread.
- [ ] Existing/global chat tetap global.
- [ ] Dua workspace dengan preference yang saling bertentangan tidak leak,
      deduplicate, conflict, atau supersede lintas scope.
- [ ] Create task, transition, checkpoint, attach resource, dan Continue Work.
- [ ] Chat/tool/task activity menjadi observation/candidate asynchronously.
- [ ] Review/edit/change-scope/reject candidate dan suppression.
- [ ] Procedure candidate menjadi versioned learned skill.
- [ ] Create workflow automation, approve, schedule, retry/cancel, dan lihat run
      history.
- [ ] Create agent/skill automation dan pastikan runtime benar-benar berjalan.
- [ ] Delegate bounded work, partial failure, timeout, dan cancel child.
- [ ] Permanent workspace purge menghapus internal scoped data dan menyimpan
      sanitized tombstone tanpa menghapus external resource.
- [ ] Feature flag off mempertahankan legacy behavior.

### Non-functional gate

- [ ] Security review: ownership, permission intersection, approval recheck,
      prompt-injection boundary, secret/sensitive filtering.
- [ ] Reliability: queue retry, idempotency, stale-run sweep, scheduler restart,
      database transaction boundaries.
- [ ] Observability: event/run correlation, queue lag, failure rate, retry count,
      automation/delegation duration.
- [ ] Performance: chat stream latency, memory recall latency, worker throughput,
      dashboard query bounds.
- [ ] Data lifecycle: archive, retention, suppression, purge, tombstone, and
      forward-fix recovery.

### Rollout sequence per feature flag

1. Deploy additive migration dengan flag mati.
2. Jalankan backfill.
3. Jalankan integrity verification.
4. Aktifkan pada test/dev.
5. Internal rollout untuk user terbatas.
6. Monitor error, queue lag, latency, dan data integrity.
7. Naikkan rollout secara bertahap.
8. Jadikan default-on setelah stability window.
9. Hapus flag dan fallback code hanya setelah rollback window berakhir.

### Recommended flag order

1. `IRIS_WORKSPACES_V2`
2. scoped memory behavior bersama workspace rollout
3. `IRIS_LEARNING_V2`
4. `IRIS_AUTOMATION_V2`
5. `IRIS_DELEGATION_V2`

### Verification commands

```powershell
pnpm lint
pnpm check-types
pnpm test
pnpm db:check
pnpm build
pnpm test:e2e
```

Tambahkan targeted migration/integration commands sesuai harness Fase 1. Jangan
gunakan `pnpm check` untuk audit read-only.

### Acceptance gate

- [ ] Seluruh unit, integration, migration, dan targeted E2E lulus.
- [ ] Tidak ada Critical/Important finding terbuka dari code/security review.
- [ ] Rollback drill untuk setiap feature flag berhasil.
- [ ] Dashboard/metrics dapat mendeteksi stuck event/run.
- [ ] Dokumentasi operator dan user-facing behavior diperbarui.
- [ ] Branch siap PR dengan migration evidence dan test output.

### Commit yang disarankan

1. `test: add IRIS V2 vertical slice end-to-end coverage`
2. `chore: add V2 observability and rollout gates`
3. `docs: document IRIS V2 operations and recovery`

---

## 3. Definition of Done untuk Setiap Fase

Sebuah fase hanya boleh dicentang selesai jika seluruh kondisi berikut terpenuhi:

- [ ] Scope implementasi dan non-goal ditulis jelas.
- [ ] Test ditulis sebelum atau bersama perubahan dengan happy path dan minimal
      satu failure/security case.
- [ ] Ownership, scope, approval, provenance, dan sanitization ditinjau.
- [ ] Idempotency dan cancellation ditinjau untuk asynchronous work.
- [ ] Migration/recovery path tersedia jika storage berubah.
- [ ] `pnpm lint`, `pnpm check-types`, dan `pnpm test` lulus.
- [ ] Targeted integration/migration/E2E test lulus.
- [ ] Code review tidak menyisakan Critical/Important finding.
- [ ] Workstream checkpoint mencatat command, hasil, blocker, dan next action.
- [ ] Commit menggunakan Conventional Commit dan tidak memasukkan secret atau
      file user yang tidak terkait.

## 4. Checklist Memulai Sesi Berikutnya

1. Checkout `codex/iris-v2-foundation` atau branch lanjutan dari branch tersebut.
2. Baca `ROADMAP.md`, `.agent/MEMORY.md`, dan active IRIS V2 checkpoint.
3. Jalankan `git status` dan rekonsiliasi checkpoint sebelum edit.
4. Pilih hanya satu fase/subfase dengan acceptance gate yang jelas.
5. Mulai dari failing test atau migration fixture yang membuktikan behavior.
6. Jalankan targeted test selama iterasi.
7. Jalankan full gate sebelum commit/checkpoint.

## 5. Next Exact Action

Jika PostgreSQL disposable belum tersedia, mulai dari Fase 3 tanpa mengubah
schema:

1. Buat `src/lib/automation/execution-adapter.test.ts`.
2. Definisikan test contract untuk workflow, skill, agent, inaccessible target,
   revoked approval, cancellation, dan structured failure.
3. Jalankan:

   ```powershell
   pnpm test src/lib/automation/execution-adapter.test.ts
   ```

4. Pastikan test gagal karena execution adapter belum tersedia.
5. Implementasikan `src/lib/automation/execution-adapter.ts` dengan existing
   workflow/skill/agent runtimes.

Jika PostgreSQL disposable tersedia, kerjakan Fase 1 lebih dahulu karena semua
fase lain bergantung pada storage integrity yang sudah terbukti.
