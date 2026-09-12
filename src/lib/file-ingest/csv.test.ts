import { describe, expect, it } from "vitest";
import {
  formatCsvPreviewText,
  neutralizeCsvCell,
  parseCsvPreview,
} from "./csv";

describe("neutralizeCsvCell", () => {
  it("prefixes formula-triggering cells", () => {
    for (const dangerous of ["=cmd()", "+1", "-1+1", "@SUM(A1)", "\tTAB"]) {
      expect(neutralizeCsvCell(dangerous)).toBe(`'${dangerous}`);
    }
  });

  it("leaves safe cells untouched", () => {
    expect(neutralizeCsvCell("plain value")).toBe("plain value");
    expect(neutralizeCsvCell(undefined)).toBe("");
  });
});

describe("parseCsvPreview byte cap", () => {
  it("stops parsing at maxBytes", () => {
    const big = Buffer.from(
      Array.from({ length: 10_000 }, (_, i) => `row${i},x\n`).join(""),
    );
    const preview = parseCsvPreview(big, { maxBytes: 512 });
    expect(preview.totalRows).toBeLessThan(10_000);
  });

  it("neutralizes formula cells in the markdown preview", () => {
    const csv = Buffer.from("name,cmd\nok,=1+1\n");
    const preview = parseCsvPreview(csv);
    expect(preview.markdownTable).toContain("'=1+1");
  });
});

describe("parseCsvPreview", () => {
  it("parses simple CSV and limits rows/cols", () => {
    const csv = "a,b,c\n1,2,3\n4,5,6\n7,8,9\n";
    const res = parseCsvPreview(Buffer.from(csv), { maxRows: 2, maxCols: 2 });
    expect(res.header).toEqual(["a", "b"]);
    expect(res.rows).toEqual([
      ["1", "2"],
      ["4", "5"],
    ]);
    expect(res.columns).toBe(2);
    expect(res.totalRows).toBe(4); // includes header
    expect(res.markdownTable).toContain("| a | b |");
  });

  it("handles quoted fields and escaped quotes", () => {
    const csv = 'name,desc\n"ACME, Inc.","He said ""hello"""\n';
    const res = parseCsvPreview(Buffer.from(csv));
    expect(res.header).toEqual(["name", "desc"]);
    expect(res.rows[0]).toEqual(["ACME, Inc.", 'He said "hello"']);
  });

  it("formats preview text with summary metadata", () => {
    const csv = "col1,col2\n1,2\n3,4\n";
    const preview = parseCsvPreview(Buffer.from(csv));
    const text = formatCsvPreviewText("sample.csv", preview);
    expect(text).toContain("sample.csv");
    expect(text).toContain("rows: 3");
    expect(text).toContain("cols: 2");
    expect(text).toContain("| col1 | col2 |");
  });
});
