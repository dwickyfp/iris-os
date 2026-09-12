import { describe, expect, it, vi } from "vitest";

vi.mock("lib/db/pg/db.pg", () => ({ pgDb: {} }));

const { lexicalTerms, prefixTsQuery } = await import("./lexical-search");

describe("lexical search", () => {
  it("drops stopwords, short tokens, and caps the term count", () => {
    expect(lexicalTerms("aku DAN yang untuk kopi susu gula aren enak")).toEqual(
      // first 10 surviving terms, stopwords and 2-char tokens removed
      ["kopi", "susu", "gula", "aren", "enak"].slice(0, 10),
    );
  });

  it("builds OR-joined prefix queries for stemming-free matching", () => {
    expect(prefixTsQuery(["kerja", "kopi"])).toBe("kerja:* | kopi:*");
  });

  it("strips tsquery operators and drops stripped-out tokens", () => {
    expect(prefixTsQuery(["kopi&", "(jus)", "ab"])).toBe("kopi:* | jus:*");
    expect(prefixTsQuery(["&", "ab", "*"])).toBeNull();
  });
});
