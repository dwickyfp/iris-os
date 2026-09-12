import "load-env";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import {
  buildRecallQuery,
  lexicalTerms,
  prefixTsQuery,
} from "../src/lib/ai/memory/lexical-search";
import {
  memoryContentHash,
  normalizeMemoryText,
} from "../src/lib/ai/memory/curator";

// ---------------------------------------------------------------------------
// Benchmark for the memory hot path added in 0073_memory_content_hash_and_chat_fts:
//  1. pure-JS text pipeline (normalization, hashing, term extraction)
//  2. exact-duplicate detection: legacy 500-row JS scan vs indexed hash lookup
//  3. real Postgres plans: chat-message FTS recall with vs without the GIN index
// Run: pnpm tsx scripts/memory-benchmark.ts
// ---------------------------------------------------------------------------

function syntheticCorpus(size: number): string[] {
  const topics = [
    "kopi gayo",
    "jus jambu",
    "meeting rutin",
    "deploy produksi",
    "review kode",
    "jadwal senam",
    "budget marketing",
    "dokumen kontrak",
    "server staging",
    "preferensi jawaban",
  ];
  const corpus: string[] = [];
  for (let i = 0; i < size; i++) {
    const topic = topics[i % topics.length];
    const variant = i % 7;
    corpus.push(
      variant === 0
        ? `Aku suka ${topic} sejak ${2020 + (i % 5)}!`
        : variant === 1
          ? `  ${topic.toUpperCase()} — catatan #${i} `
          : `User menyebut ${topic} pada konteks ke-${i}, dengan detail tambahan panjang agar teks tidak seragam.`,
    );
  }
  return corpus;
}

function bench(label: string, iterations: number, fn: () => void) {
  fn(); // warmup
  const started = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsedMs = performance.now() - started;
  console.log(
    `${label.padEnd(64)} ${iterations} iters in ${elapsedMs.toFixed(1)} ms  (${((elapsedMs / iterations) * 1000).toFixed(1)} µs/op)`,
  );
}

async function benchmarkJs() {
  const corpus = syntheticCorpus(20_000);
  console.log("\n== JS text pipeline (corpus of 20,000 memory contents) ==");
  bench("normalizeMemoryText over corpus", 20, () => {
    for (const text of corpus) normalizeMemoryText(text);
  });
  bench("memoryContentHash over corpus", 20, () => {
    for (const text of corpus) memoryContentHash(text);
  });
  bench("lexicalTerms over corpus", 20, () => {
    for (const text of corpus) lexicalTerms(text);
  });
  bench("prefixTsQuery over corpus", 20, () => {
    for (const text of corpus) prefixTsQuery(lexicalTerms(text));
  });
  bench(
    "buildRecallQuery (thin current message + 3 prior turns)",
    20_000,
    () => {
      buildRecallQuery("seperti biasa", [
        "baru meeting rutin minggu lalu",
        "deploy produksi malam ini",
        "review kode pull request",
      ]);
    },
  );

  console.log(
    "\n== Exact-claim dedup per add: legacy 500-row JS scan vs hash lookup ==",
  );
  const scopeRows = corpus.slice(0, 500); // what findExactActiveClaim used to load
  const lookups = syntheticCorpus(2_000);
  bench("legacy: normalize up to 500 rows per lookup", 2, () => {
    for (const content of lookups) {
      const needle = normalizeMemoryText(content);
      scopeRows.find((row) => normalizeMemoryText(row) === needle);
    }
  });
  const hashIndex = new Map(
    scopeRows.map((row) => [memoryContentHash(row), row]),
  );
  bench("new: sha256(content) + O(1) hash-index lookup", 20, () => {
    for (const content of lookups) {
      hashIndex.get(memoryContentHash(content));
    }
  });
}

async function benchmarkDb() {
  if (!process.env.POSTGRES_URL) {
    console.log("\n== Postgres plans skipped: POSTGRES_URL not set ==");
    return;
  }
  const pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    max: 1,
  });
  try {
    const ROWS = 100_000;
    console.log(
      `\n== Postgres: chat-message FTS recall over ${ROWS.toLocaleString()} rows (temp tables, session-local) ==`,
    );
    await pool.query(`
      CREATE TEMP TABLE bench_chat_search (id serial primary key, content text);
      INSERT INTO bench_chat_search (content)
      SELECT case
               when g % 100 = 0 then
                 'Catatan langka tentang puncak jaya nomor ' || g::text
               when g % 7 = 0 then
                 'Aku suka jus jambu sejak ' || (2020 + g % 5)::text
               else
                 'User menyebut kopi gaya pada konteks ke-' || g::text
             end
      FROM generate_series(1, ${ROWS}) g;
    `);
  } catch (error) {
    console.log(
      "temp table bootstrap failed, falling back:",
      (error as Error).message,
    );
  }

  const queryText =
    "SELECT id FROM bench_chat_search WHERE to_tsvector('simple', content) @@ websearch_to_tsquery('simple', $1) ORDER BY ts_rank(to_tsvector('simple', content), websearch_to_tsquery('simple', $1)) DESC LIMIT 4";

  const without = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) ${queryText}`,
    ["puncak jaya"],
  );
  console.log("\n-- WITHOUT GIN index (legacy plan) --");
  console.log(without.rows.map((row) => row["QUERY PLAN"]).join("\n"));

  await pool.query(
    "CREATE INDEX bench_chat_search_fts ON bench_chat_search USING gin (to_tsvector('simple', content))",
  );
  const withIndex = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) ${queryText}`,
    ["puncak jaya"],
  );
  console.log("\n-- WITH GIN index (0073 plan) --");
  console.log(withIndex.rows.map((row) => row["QUERY PLAN"]).join("\n"));

  console.log("\n== Postgres: exact-claim dedup by indexed content hash ==");
  await pool.query(`
    CREATE TEMP TABLE bench_memory (
      id serial primary key,
      user_id uuid not null default '11111111-1111-4111-8111-111111111111',
      scope_type text not null default 'global',
      scope_id uuid,
      content text not null,
      content_hash varchar(64) not null default '',
      status text not null default 'active',
      deleted_at timestamptz
    );
    INSERT INTO bench_memory (content, content_hash)
    SELECT 'Aku suka jus jambu sejak ' || (2020 + g % 5)::text,
           encode(sha256(convert_to('hash' || g::text, 'UTF8')), 'hex')
    FROM generate_series(1, 50_000) g;
    CREATE INDEX bench_memory_hash_idx
      ON bench_memory (user_id, scope_type, scope_id, content_hash);
  `);
  const hashLookup = await pool.query(
    `EXPLAIN (ANALYZE, TIMING OFF) SELECT * FROM bench_memory
     WHERE user_id = '11111111-1111-4111-8111-111111111111'
       AND scope_type = 'global' AND scope_id IS NULL
       AND status = 'active' AND deleted_at IS NULL
       AND content_hash = $1`,
    ["a".repeat(64)],
  );
  console.log(hashLookup.rows.map((row) => row["QUERY PLAN"]).join("\n"));

  await pool.end();
}

async function main() {
  console.log("Memory hot-path benchmark");
  await benchmarkJs();
  await benchmarkDb();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
