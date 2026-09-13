/**
 * Hard bounds for the workspace filesystem. These exist so the tool API can
 * be the security boundary without a code-execution sandbox: every file,
 * path, and query result is bounded, keeping the agent's context window and
 * the database footprint predictable.
 */
export const WORKSPACE_FS_LIMITS = {
  /** Maximum UTF-8 byte size of a single file. */
  maxFileBytes: 512 * 1024,
  /** Maximum total UTF-8 bytes per user per scope. */
  maxTotalBytes: 32 * 1024 * 1024,
  /** Maximum number of files per user per scope. */
  maxFiles: 1000,
  /** Maximum normalized path length in characters. */
  maxPathLength: 512,
  /** Maximum number of path segments. */
  maxPathDepth: 16,
  /** Maximum entries returned by a single list operation. */
  maxListEntries: 500,
  /** Default maximum lines returned by read. */
  maxReadLines: 2000,
  /** Maximum UTF-8 bytes of read output before truncation. */
  maxReadOutputBytes: 64 * 1024,
  /** Maximum files searched/returned by search. */
  maxSearchMatches: 50,
  /** Maximum matched lines reported per file. */
  maxSearchLinesPerFile: 5,
  /** Maximum artifact bytes importable into a workspace. */
  maxImportBytes: 512 * 1024,
} as const;

export type WorkspaceFsLimits = {
  -readonly [K in keyof typeof WORKSPACE_FS_LIMITS]: number;
};
