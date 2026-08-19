import { createHash } from "node:crypto";

export type Evidence = Record<string, unknown> & {
  evidenceVersion: 1;
  operation: string;
  passed: boolean;
};

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

export function stableJson(value: unknown) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function sealEvidence(evidence: Evidence) {
  const payload = stableJson(evidence);
  return {
    evidence,
    hash: createHash("sha256").update(payload).digest("hex"),
    json: payload,
  };
}

export function evidenceMarkdown(evidence: Evidence, hash: string) {
  const details = Object.entries(evidence)
    .filter(
      ([key]) => !["evidenceVersion", "operation", "passed"].includes(key),
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, value]) => `| ${key} | \`${JSON.stringify(sortValue(value))}\` |`,
    )
    .join("\n");
  return (
    `# Migration ${evidence.operation} Evidence\n\n` +
    `- Result: **${evidence.passed ? "PASS" : "FAIL"}**\n` +
    `- Evidence SHA-256: \`${hash}\`\n\n` +
    `| Field | Value |\n| --- | --- |\n${details}\n`
  );
}

export function verifyEvidence(raw: string, expectedHash: string) {
  const evidence = JSON.parse(raw) as Evidence;
  const sealed = sealEvidence(evidence);
  if (sealed.hash !== expectedHash) throw new Error("Evidence hash mismatch");
  return evidence;
}
