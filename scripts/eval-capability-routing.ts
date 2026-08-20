import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import corpus from "../evals/capability-routing/corpus.json";
import type { CapabilityDescriptor } from "../src/lib/ai/runtime/capabilities/registry";
import {
  capabilitySearchDocument,
  routeCapabilityDocuments,
} from "../src/lib/ai/runtime/capabilities/semantic-router";

type EvaluationCase = {
  id: string;
  category: string;
  query: string;
  required: string[];
  hinted?: string[];
  mode?: "prefer" | "only";
  unauthorized?: string[];
  policyDenied?: string[];
  degraded?: boolean;
  catalogSize?: number;
  expectClarification?: boolean;
  expectPreserveAll?: boolean;
};

const RELEASE_THRESHOLDS = {
  requiredRecall: 0.95,
  hintRetention: 1,
  unauthorizedRate: 0,
  forbiddenRate: 0,
  policyDeniedRate: 0,
  medianReductionAt100: 0.7,
};

function capability(
  id: string,
  name: string,
  description: string,
  aliases: string[] = [],
): CapabilityDescriptor {
  return {
    id,
    key: id,
    kind: "builtin",
    name,
    description,
    surfaces: ["executable"],
    value: id,
    search: { aliases },
  };
}

const catalog = [
  capability(
    "finance:revenue",
    "Revenue analysis",
    "Analyze finance revenue income",
  ),
  capability(
    "finance:forecast",
    "Cash flow forecast",
    "Forecast finance cash flow",
  ),
  capability(
    "crm:pipeline",
    "CRM pipeline",
    "Update CRM sales pipeline opportunity",
  ),
  capability(
    "email:send",
    "Send email",
    "Send customer email campaign message",
  ),
  capability(
    "email:draft",
    "Draft email",
    "Draft customer email campaign copy",
  ),
  capability(
    "calendar:schedule",
    "Schedule meeting",
    "Schedule calendar meeting team",
  ),
  capability("coding:review", "Code review", "Review TypeScript code bug"),
  capability("coding:edit", "Code editor", "Fix edit TypeScript code bug"),
  capability(
    "research:web",
    "Web research",
    "Research web market literature sources",
  ),
  capability(
    "research:citations",
    "Citation collector",
    "Collect research literature sources citations",
  ),
  capability(
    "reporting:generate",
    "Report generator",
    "Generate executive dashboard report",
  ),
  capability(
    "workflow:approval",
    "Approval workflow",
    "Run approval automation workflow",
  ),
  capability(
    "admin:console",
    "Admin console",
    "Privileged admin console operations",
  ),
  capability(
    "danger:database-delete",
    "Delete database",
    "Delete production database",
  ),
  ...Array.from({ length: 112 }, (_, index) =>
    capability(
      `noise:${index}`,
      `Generic utility ${index}`,
      `Archive transform utility item ${index}`,
    ),
  ),
];

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
}

const cases = (corpus as EvaluationCase[]).map((evaluation) => {
  const denied = new Set([
    ...(evaluation.unauthorized ?? []),
    ...(evaluation.policyDenied ?? []),
  ]);
  const source = catalog
    .slice(0, evaluation.catalogSize ?? catalog.length)
    .filter(({ id }) => !denied.has(id));
  const startedAt = performance.now();
  let selectedIds: string[];
  let diagnostics;

  if (evaluation.mode === "only") {
    const eligible = new Set(source.map(({ id }) => id));
    selectedIds = (evaluation.hinted ?? []).filter((id) => eligible.has(id));
    diagnostics = {
      strategy: "only" as const,
      candidateCount: source.length,
      selectedCount: selectedIds.length,
      reductionRate:
        source.length === 0 ? 0 : 1 - selectedIds.length / source.length,
      fallbackReason: undefined,
      clarificationRequired: false,
    };
  } else {
    let tick = 0;
    const routed = routeCapabilityDocuments(
      source.map((item) => capabilitySearchDocument(item)),
      evaluation.query,
      new Set(evaluation.hinted ?? []),
      evaluation.degraded
        ? { config: { timeoutMs: 1 }, now: () => tick++ }
        : undefined,
    );
    selectedIds = routed.selectedIds;
    diagnostics = routed.diagnostics;
  }

  const selected = new Set(selectedIds);
  const relevant = new Set([
    ...evaluation.required,
    ...(evaluation.hinted ?? []).filter((id) => !denied.has(id)),
  ]);
  const relevantSelected = selectedIds.filter((id) => relevant.has(id)).length;
  const requiredSelected = evaluation.required.filter((id) => selected.has(id));
  const hintedSelected = (evaluation.hinted ?? []).filter(
    (id) => !denied.has(id) && selected.has(id),
  );

  return {
    id: evaluation.id,
    category: evaluation.category,
    candidateCount: diagnostics.candidateCount,
    selectedCount: selectedIds.length,
    selectedIds,
    required: evaluation.required,
    recallAtK:
      evaluation.required.length === 0
        ? 1
        : requiredSelected.length / evaluation.required.length,
    precisionAtK:
      selectedIds.length === 0 ? 1 : relevantSelected / selectedIds.length,
    requiredSelected: requiredSelected.length,
    requiredCount: evaluation.required.length,
    hintsSelected: hintedSelected.length,
    hintsCount: (evaluation.hinted ?? []).filter((id) => !denied.has(id))
      .length,
    unauthorizedSelected: (evaluation.unauthorized ?? []).filter((id) =>
      selected.has(id),
    ).length,
    policyDeniedSelected: (evaluation.policyDenied ?? []).filter((id) =>
      selected.has(id),
    ).length,
    fallback: diagnostics.strategy === "fallback",
    clarificationRequired: diagnostics.clarificationRequired,
    expectedClarification: evaluation.expectClarification ?? false,
    preserveAllPassed:
      !evaluation.expectPreserveAll || selectedIds.length === source.length,
    latencyMs: Number((performance.now() - startedAt).toFixed(3)),
    reductionRate: diagnostics.reductionRate,
    diagnostics,
  };
});

const sum = (values: number[]) =>
  values.reduce((total, value) => total + value, 0);
const requiredCount = sum(cases.map((item) => item.requiredCount));
const hintCount = sum(cases.map((item) => item.hintsCount));
const forbiddenSelected = sum(
  cases.map((item) => item.unauthorizedSelected + item.policyDeniedSelected),
);
const largeRoutedCases = cases.filter(
  (item) =>
    item.candidateCount >= 100 &&
    item.diagnostics.strategy === "stage1-lexical",
);
const metrics = {
  recallAtK: sum(cases.map((item) => item.recallAtK)) / cases.length,
  precisionAtK: sum(cases.map((item) => item.precisionAtK)) / cases.length,
  requiredRecall:
    requiredCount === 0
      ? 1
      : sum(cases.map((item) => item.requiredSelected)) / requiredCount,
  hintRetention:
    hintCount === 0
      ? 1
      : sum(cases.map((item) => item.hintsSelected)) / hintCount,
  unauthorizedRate:
    sum(cases.map((item) => item.unauthorizedSelected)) / cases.length,
  forbiddenRate: forbiddenSelected / cases.length,
  policyDeniedRate:
    sum(cases.map((item) => item.policyDeniedSelected)) / cases.length,
  fallbackRate: cases.filter((item) => item.fallback).length / cases.length,
  clarificationAccuracy:
    cases.filter(
      (item) => item.clarificationRequired === item.expectedClarification,
    ).length / cases.length,
  latencyMs: {
    median: percentile(
      cases.map((item) => item.latencyMs),
      0.5,
    ),
    p95: percentile(
      cases.map((item) => item.latencyMs),
      0.95,
    ),
  },
  medianReductionAt100: percentile(
    largeRoutedCases.map((item) => item.reductionRate),
    0.5,
  ),
};
const gates = {
  requiredRecall: metrics.requiredRecall >= RELEASE_THRESHOLDS.requiredRecall,
  hintRetention: metrics.hintRetention >= RELEASE_THRESHOLDS.hintRetention,
  unauthorizedRate:
    metrics.unauthorizedRate <= RELEASE_THRESHOLDS.unauthorizedRate,
  forbiddenRate: metrics.forbiddenRate <= RELEASE_THRESHOLDS.forbiddenRate,
  policyDeniedRate:
    metrics.policyDeniedRate <= RELEASE_THRESHOLDS.policyDeniedRate,
  medianReductionAt100:
    metrics.medianReductionAt100 >= RELEASE_THRESHOLDS.medianReductionAt100,
  clarification: metrics.clarificationAccuracy === 1,
  preserveAll: cases.every((item) => item.preserveAllPassed),
};
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  releasePassed: Object.values(gates).every(Boolean),
  thresholds: RELEASE_THRESHOLDS,
  metrics,
  gates,
  corpus: {
    caseCount: cases.length,
    categories: [...new Set(cases.map(({ category }) => category))],
  },
  cases,
};

const outputPath = process.env.CAPABILITY_ROUTING_REPORT;
if (outputPath) {
  await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.releasePassed) process.exitCode = 1;
