/**
 * Best-effort repair for LLM-generated Mermaid charts.
 *
 * Models frequently emit node/edge labels with unescaped double quotes or
 * parentheses (e.g. `A[Tekan tombol<br/>"Login"]`), which Mermaid's parser
 * rejects. Mermaid only treats those characters as literal text when the whole
 * label is wrapped in double quotes, so we wrap offending labels and escape
 * their inner quotes with the `#quot;` entity.
 */

const QUOTED_LABEL = /^"[\s\S]*"$/;

function sanitizeLabel(body: string): string {
  if (QUOTED_LABEL.test(body)) return body;
  if (!/["()]/.test(body)) return body;
  const escaped = body.replace(/"/g, "#quot;");
  return `"${escaped}"`;
}

export function sanitizeMermaidChart(chart: string): string {
  return (
    chart
      // Node labels: A[...], A(...), A{...} (single line, non-nested)
      .replace(
        /\[([^\][\n]*)\]/g,
        (_m, body: string) => `[${sanitizeLabel(body)}]`,
      )
      .replace(
        /\(([^()\n]*)\)/g,
        (_m, body: string) => `(${sanitizeLabel(body)})`,
      )
      .replace(
        /\{([^{}\n]*)\}/g,
        (_m, body: string) => `{${sanitizeLabel(body)}}`,
      )
      // Edge labels: -->|text|
      .replace(
        /\|([^|\n]*)\|/g,
        (_m, body: string) => `|${sanitizeLabel(body)}|`,
      )
  );
}
