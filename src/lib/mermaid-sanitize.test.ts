import { describe, expect, it } from "vitest";
import { sanitizeMermaidChart } from "./mermaid-sanitize";

describe("sanitizeMermaidChart", () => {
  it("wraps unquoted square labels containing quotes", () => {
    const input = `flowchart TD
  A[Tekan tombol<br/>"Login with Google/Facebook"] --> B[Dashboard]`;
    const output = sanitizeMermaidChart(input);
    expect(output).toBe(
      `flowchart TD
  A["Tekan tombol<br/>#quot;Login with Google/Facebook#quot;"] --> B[Dashboard]`,
    );
  });

  it("leaves already quoted labels untouched", () => {
    const input = `flowchart LR
  A["Login (step 1)"] -->|"next"| B["Dashboard"]`;
    expect(sanitizeMermaidChart(input)).toBe(input);
  });

  it("wraps unquoted labels containing parentheses", () => {
    expect(sanitizeMermaidChart("A[Click (button)] --> B[Ok]")).toBe(
      'A["Click (button)"] --> B[Ok]',
    );
  });

  it("sanitizes round and brace node labels", () => {
    expect(sanitizeMermaidChart('A(Tekan "Login")')).toBe(
      'A("Tekan #quot;Login#quot;")',
    );
    expect(sanitizeMermaidChart('A{Status "OK"}')).toBe(
      'A{"Status #quot;OK#quot;"}',
    );
  });

  it("sanitizes edge labels with quotes", () => {
    expect(sanitizeMermaidChart('A -->|Tekan "Login"| B')).toBe(
      'A -->|"Tekan #quot;Login#quot;"| B',
    );
  });

  it("leaves labels without special characters untouched", () => {
    const input = `flowchart TD
  A[Start] --> B{Question} --> C[End]`;
    expect(sanitizeMermaidChart(input)).toBe(input);
  });

  it("leaves non-label lines untouched", () => {
    const input = `flowchart TD
  A[Start] --> B
  B --> C[End]`;
    expect(sanitizeMermaidChart(input)).toBe(input);
  });
});
