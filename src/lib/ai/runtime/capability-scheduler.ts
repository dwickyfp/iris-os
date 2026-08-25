export type CapabilityConcurrency = "parallel" | "exclusive";

export type CapabilityScheduleMetadata = {
  concurrency: CapabilityConcurrency;
};

export type CapabilityScheduleRequest<T> = {
  metadata: CapabilityScheduleMetadata;
  execute: (signal?: AbortSignal) => T | Promise<T>;
};

export type CapabilityScheduleResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "skipped"; reason: "cancelled" };

export type CapabilityScheduleOptions<T> = {
  signal?: AbortSignal;
  onCommit?: (
    result: CapabilityScheduleResult<T>,
    index: number,
  ) => void | Promise<void>;
};

export type CapabilitySchedulerAdmission<T> = {
  metadata: CapabilityScheduleMetadata;
  execute: (signal?: AbortSignal) => T | Promise<T>;
  signal?: AbortSignal;
};

type PendingAdmission<T> = CapabilitySchedulerAdmission<T> & {
  resolve: (result: CapabilityScheduleResult<T>) => void;
};

/** Maintains bounded admission across calls submitted throughout one run. */
export class CapabilitySchedulerSession {
  private readonly pending: PendingAdmission<unknown>[] = [];
  private active = 0;
  private exclusiveActive = false;

  constructor(readonly maxConcurrency: number) {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError("maxConcurrency must be a positive integer");
    }
  }

  admit<T>(
    admission: CapabilitySchedulerAdmission<T>,
  ): Promise<CapabilityScheduleResult<T>> {
    if (admission.signal?.aborted) {
      return Promise.resolve({ status: "skipped", reason: "cancelled" });
    }
    return new Promise((resolve) => {
      this.pending.push({
        ...admission,
        resolve: resolve as (result: CapabilityScheduleResult<unknown>) => void,
      });
      this.pump();
    });
  }

  private pump() {
    if (this.exclusiveActive || this.pending.length === 0) return;
    const next = this.pending[0];
    if (next.metadata.concurrency === "exclusive") {
      if (this.active > 0) return;
      this.pending.shift();
      this.exclusiveActive = true;
      this.run(next);
      return;
    }

    while (
      this.active < this.maxConcurrency &&
      this.pending[0]?.metadata.concurrency === "parallel"
    ) {
      this.run(this.pending.shift()!);
    }
  }

  private async run(admission: PendingAdmission<unknown>) {
    this.active++;
    let result: CapabilityScheduleResult<unknown>;
    if (admission.signal?.aborted) {
      result = { status: "skipped", reason: "cancelled" };
    } else {
      try {
        result = {
          status: "fulfilled",
          value: await admission.execute(admission.signal),
        };
      } catch (error) {
        result = { status: "rejected", error };
      }
    }
    this.active--;
    if (admission.metadata.concurrency === "exclusive") {
      this.exclusiveActive = false;
    }
    admission.resolve(result);
    this.pump();
  }
}

/** Runs one ordered batch with bounded parallelism and exclusive barriers. */
export class CapabilityScheduler {
  constructor(readonly maxConcurrency: number) {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError("maxConcurrency must be a positive integer");
    }
  }

  createSession() {
    return new CapabilitySchedulerSession(this.maxConcurrency);
  }

  async schedule<T>(
    requests: readonly CapabilityScheduleRequest<T>[],
    options: CapabilityScheduleOptions<T> = {},
  ): Promise<CapabilityScheduleResult<T>[]> {
    const results = new Array<CapabilityScheduleResult<T>>(requests.length);
    let next = 0;

    while (next < requests.length && !options.signal?.aborted) {
      const groupStart = next;
      const exclusive = requests[next].metadata.concurrency === "exclusive";

      if (exclusive) {
        next++;
      } else {
        while (
          next < requests.length &&
          requests[next].metadata.concurrency === "parallel"
        ) {
          next++;
        }
      }

      await this.runGroup(
        requests,
        results,
        groupStart,
        next,
        exclusive ? 1 : this.maxConcurrency,
        options.signal,
      );
    }

    for (let index = 0; index < requests.length; index++) {
      const result =
        results[index] ?? ({ status: "skipped", reason: "cancelled" } as const);
      results[index] = result;
      await options.onCommit?.(result, index);
    }

    return results;
  }

  private async runGroup<T>(
    requests: readonly CapabilityScheduleRequest<T>[],
    results: CapabilityScheduleResult<T>[],
    start: number,
    end: number,
    concurrency: number,
    signal?: AbortSignal,
  ) {
    let next = start;

    const worker = async () => {
      while (next < end && !signal?.aborted) {
        const index = next++;
        try {
          results[index] = {
            status: "fulfilled",
            value: await requests[index].execute(signal),
          };
        } catch (error) {
          results[index] = { status: "rejected", error };
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, end - start) }, worker),
    );
  }
}
