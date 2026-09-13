import { performance } from "node:perf_hooks";
import { createInMemoryWorkspaceFileRepository } from "../src/lib/ai/workspace-fs/in-memory-repository";
import { WorkspaceFileService } from "../src/lib/ai/workspace-fs/service";

/**
 * Service-layer micro-benchmark for the workspace filesystem (the repository
 * is in-memory, so numbers represent validation/service overhead without
 * Postgres). Run with `pnpm benchmark:workspace-fs`.
 */

const FILE_COUNT = 200;
const FILE_SIZE_BYTES = 2 * 1024;
const ITERATIONS = 200;

type Sample = { operation: string; ms: number };

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index]!;
}

async function measure(
  label: string,
  run: () => Promise<void>,
  iterations = ITERATIONS,
): Promise<Sample> {
  for (let i = 0; i < 5; i += 1) await run();
  const durations: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    await run();
    durations.push(performance.now() - start);
  }
  const total = durations.reduce((sum, ms) => sum + ms, 0);
  console.log(
    `${label.padEnd(28)} p50 ${percentile(durations, 50).toFixed(3)}ms  ` +
      `p95 ${percentile(durations, 95).toFixed(3)}ms  ` +
      `ops/s ${(iterations / (total / 1000)).toFixed(0)}`,
  );
  return { operation: label, ms: total / iterations };
}

async function main() {
  const repository = createInMemoryWorkspaceFileRepository();
  const service = new WorkspaceFileService(repository);
  const scope = { userId: "bench-user" };
  const content = Array.from(
    { length: 40 },
    (_, i) => `line ${i} lorem ipsum dolor sit amet`,
  ).join("\n");
  const paths = Array.from(
    { length: FILE_COUNT },
    (_, i) => `docs/dir${i % 20}/file-${i}.md`,
  );

  const setupStart = performance.now();
  for (const path of paths) {
    const result = await service.write({ scope, path, content });
    if (!result.ok) throw new Error(`setup failed: ${result.message}`);
  }
  const setupMs = performance.now() - setupStart;
  console.log(
    `seeded ${FILE_COUNT} files (~${FILE_SIZE_BYTES} B each) in ${setupMs.toFixed(0)}ms\n`,
  );

  let writeIndex = 0;
  await measure("write (new file)", async () => {
    writeIndex += 1;
    const result = await service.write({
      scope,
      path: `tmp/write-${writeIndex % 50}.txt`,
      content,
    });
    if (!result.ok) throw new Error(result.message);
  });

  await measure("read (full, ~2 KiB)", async () => {
    const result = await service.read({ scope, path: "docs/dir3/file-3.md" });
    if (!result.ok) throw new Error(result.message);
  });

  await measure("read (100 lines)", async () => {
    const result = await service.read({
      scope,
      path: "docs/dir3/file-3.md",
      limit: 100,
    });
    if (!result.ok) throw new Error(result.message);
  });

  await measure("edit (single snippet)", async () => {
    const changed = await service.edit({
      scope,
      path: "docs/dir5/file-5.md",
      oldText: "line 10 lorem ipsum dolor sit amet",
      newText: "line 10 CHANGED",
    });
    if (!changed.ok) throw new Error(changed.message);
    const restored = await service.edit({
      scope,
      path: "docs/dir5/file-5.md",
      oldText: "line 10 CHANGED",
      newText: "line 10 lorem ipsum dolor sit amet",
    });
    if (!restored.ok) throw new Error(restored.message);
  });

  await measure("list (200 entries)", async () => {
    const result = await service.list({ scope });
    if (!result.ok) throw new Error(result.message);
  });

  await measure("search grep (1 term)", async () => {
    const result = await service.search({ scope, grep: "CHANGED" });
    if (!result.ok) throw new Error(result.message);
  });

  await measure("search glob (dir20/*.md)", async () => {
    const result = await service.search({ scope, glob: "docs/dir20/*.md" });
    if (!result.ok) throw new Error(result.message);
  });

  await measure("delete", async () => {
    const result = await service.remove({ scope, path: "docs/dir7/file-7.md" });
    if (!result.ok) throw new Error(result.message);
    await service.write({ scope, path: "docs/dir7/file-7.md", content });
  });

  console.log(
    `\nNote: in-memory repository measures service/validation overhead only; ` +
      `Postgres latency dominates the real path.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
