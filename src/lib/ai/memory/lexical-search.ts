import { type SQL, sql } from "drizzle-orm";
import { normalizeMemoryText } from "lib/ai/memory/curator";
import { pgDb } from "lib/db/pg/db.pg";
import { UserMemoryTable } from "lib/db/pg/schema.pg";

const LEXICAL_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "aku",
  "saya",
  "kamu",
  "dan",
  "yang",
  "dengan",
  "untuk",
  "tidak",
  "sudah",
]);

export function lexicalTerms(query: string) {
  return normalizeMemoryText(query)
    .split(" ")
    .filter((term) => term.length > 2 && !LEXICAL_STOPWORDS.has(term))
    .slice(0, 10);
}

/**
 * 'simple' text search has no stemmer, so OR-joined prefix queries stand in
 * for stemming: "kerja:*" still matches "kerjakan"/"kerjasama"-style tokens.
 */
export function prefixTsQuery(terms: string[]) {
  const safe = terms
    .map((term) => term.replace(/[&|!():*'\\]/g, ""))
    .filter((term) => term.length > 2);
  return safe.length ? safe.map((term) => `${term}:*`).join(" | ") : null;
}

let trigramPromise: Promise<boolean> | null = null;
function trigramEnabled() {
  // pg_trgm powers the fuzzy fallback; degrades to plain FTS when absent.
  trigramPromise ??= (async () => {
    try {
      const result = await pgDb.execute<{ available: boolean }>(
        sql`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS available`,
      );
      return Boolean(result.rows[0]?.available);
    } catch {
      return false;
    }
  })();
  return trigramPromise;
}

/** Matches claims whose content hits any term prefix or fuzzy-similar text.
 * The tsvector side must spell out to_tsvector('simple', content) so the
 * expression GIN indexes (0072/0073) can serve the predicate — a bare
 * `content @@ tsquery` would force a sequential scan. */
export async function contentMatches(
  terms: string[],
): Promise<SQL | undefined> {
  const tsQuery = prefixTsQuery(terms);
  const fuzzy = terms.length ? terms.join(" ") : null;
  if (!tsQuery && !fuzzy) return undefined;
  if (!tsQuery) return sql`${UserMemoryTable.content} % ${fuzzy}`;
  if (!fuzzy || !(await trigramEnabled()))
    return sql`to_tsvector('simple', ${UserMemoryTable.content}) @@ to_tsquery('simple', ${tsQuery})`;
  return sql`(to_tsvector('simple', ${UserMemoryTable.content}) @@ to_tsquery('simple', ${tsQuery}) OR ${UserMemoryTable.content} % ${fuzzy})`;
}

/** Cover-density ranking, boosted by trigram similarity when available. */
export async function contentRank(terms: string[]): Promise<SQL | undefined> {
  const tsQuery = prefixTsQuery(terms);
  if (!tsQuery) return undefined;
  const rank = sql`ts_rank_cd(to_tsvector('simple', ${UserMemoryTable.content}), to_tsquery('simple', ${tsQuery}))`;
  const fuzzy = terms.length ? terms.join(" ") : null;
  if (fuzzy && (await trigramEnabled()))
    return sql`greatest(${rank}, similarity(${UserMemoryTable.content}, ${fuzzy}))`;
  return rank;
}

/**
 * Current-message terms come first; earlier turns only backfill when the
 * current message is too thin for lexical recall (e.g. "seperti biasa").
 */
export function buildRecallQuery(
  current: string,
  previous: string[] = [],
): string {
  const terms = lexicalTerms(current);
  if (terms.length >= 3 || !previous.length) return current;
  const seen = new Set(terms);
  const supplemented = [...terms];
  for (const message of previous) {
    for (const term of lexicalTerms(message)) {
      if (supplemented.length >= 10) break;
      if (!seen.has(term)) {
        seen.add(term);
        supplemented.push(term);
      }
    }
    if (supplemented.length >= 10) break;
  }
  return supplemented.join(" ");
}
