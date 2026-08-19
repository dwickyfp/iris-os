export type AbortCause = "timeout" | "cancelled" | "lease_lost" | undefined;

export function classifyAbortedExecution<T>(result: T, abortCause: AbortCause) {
  if (abortCause === "timeout") {
    return {
      status: "timed_out" as const,
      message: "Run deadline exceeded",
    };
  }
  if (abortCause === "cancelled") {
    return { status: "cancelled" as const, message: "Run was cancelled" };
  }
  return result;
}
