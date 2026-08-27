/**
 * Parse concurrency gate (`item-timeline` Requirement 1.4).
 *
 * A Match_Timeline response is hundreds of kilobytes to a few megabytes, and the
 * cost of this feature is the *transient* heap of `JSON.parse`-ing one, not
 * anything retained (the slice written to the cache is kilobytes). The Rate
 * Limit Manager does nothing to relieve this: the granted limit is 2,000 calls
 * per 10 seconds, so a burst of visitor requests could have dozens of
 * multi-megabyte parses in flight at once. This gate bounds how many run
 * concurrently.
 *
 * The permit source is injectable so the bound is testable without real
 * concurrency: a test passes a `ParseGate` whose `run` it drives by hand.
 *
 * Not a general-purpose semaphore on purpose — it exposes only `run`, so a
 * caller cannot acquire a permit and forget to release it. The release always
 * happens, including when the task throws.
 */

/** How many Match_Timeline responses may be parsed at once by default. */
export const DEFAULT_TIMELINE_PARSE_CONCURRENCY = 4;

export interface ParseGate {
  /**
   * Runs `task` once a permit is free, releasing the permit when it settles.
   * Permits are handed out in FIFO order of arrival.
   */
  run<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * A `ParseGate` allowing at most `maxConcurrent` tasks to run at once (coerced to
 * an integer >= 1). Waiters are queued and released in arrival order.
 */
export function createParseGate(maxConcurrent: number = DEFAULT_TIMELINE_PARSE_CONCURRENCY): ParseGate {
  const limit = Math.max(1, Math.floor(maxConcurrent));
  const waiters: (() => void)[] = [];
  let active = 0;

  function acquire(): Promise<void> {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        active += 1;
        resolve();
      });
    });
  }

  function release(): void {
    active -= 1;
    waiters.shift()?.();
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

/**
 * A pass-through `ParseGate` that imposes no bound. For call sites and tests that
 * need the seam without the throttling.
 */
export const UNBOUNDED_PARSE_GATE: ParseGate = {
  run: (task) => task(),
};
