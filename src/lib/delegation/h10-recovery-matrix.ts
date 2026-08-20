import type { H10CrashPoint } from "./worker-executor";

export const H10_CRASH_POINTS: readonly H10CrashPoint[] = [
  "after_claim",
  "after_remote_submission_before_task_id",
  "after_task_id",
  "during_polling",
  "after_waiting_persistence",
  "after_child_terminal_before_event",
  "after_artifact_persist_before_verification",
];

export const H10_HARNESS_POINTS = [
  "after_parent_observation_before_resume_dispatch",
  "after_verification_before_finalization",
] as const;

export type H10MatrixRow = {
  point: H10CrashPoint;
  recovered: boolean;
  remoteSubmissions: number;
  artifactWrites: number;
  terminalEvents: number;
  credentialClean: boolean;
  trajectoryCoherent: boolean;
};

export function formatH10MatrixReport(rows: readonly H10MatrixRow[]) {
  const header =
    "point | recovered | remote submissions | artifact writes | terminal events | credential clean | trajectory coherent";
  const body = rows.map((row) =>
    [
      row.point,
      row.recovered ? "yes" : "no",
      row.remoteSubmissions,
      row.artifactWrites,
      row.terminalEvents,
      row.credentialClean ? "yes" : "no",
      row.trajectoryCoherent ? "yes" : "no",
    ].join(" | "),
  );
  return [header, ...body].join("\n");
}
