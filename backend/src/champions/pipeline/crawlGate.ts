/**
 * champion-build-stats-pipeline: the crawler's self-throttle (task 8).
 *
 * A token bucket sitting in front of the crawler's Riot calls. It is an
 * OPEN-LOOP throttle — it has no view of `RateLimitManager.reserveSlot` (which
 * runs privately inside the Riot client's `send()`) and no view of live-lookup
 * contention. It bounds crawler *demand* to `CRAWL_RPS * fraction` requests per
 * second; it does NOT guarantee live traffic is never delayed. The real 429
 * backstop is `reserveSlot` + the shared rate-limit counter; the crawler's own
 * backstop is treating a `{ kind: 'rate_limited' }` result as a soft stop.
 *
 * `now` and `sleep` are injected so tests drive it without real timers.
 */

export interface CrawlGateOptions {
  /** A conservative estimate of the app's sustained requests/second budget. */
  rps: number;
  /** The share of `rps` the crawler may consume, in `(0, 1]`. */
  fraction: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CrawlGate {
  /** Resolves once a token is available; consumes it. */
  acquire(): Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function createCrawlGate(options: CrawlGateOptions): CrawlGate {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  // Effective refill rate; floored so a tiny fraction still trickles rather than
  // deadlocking (documented behaviour — task 8.2).
  const perSecond = Math.max(options.rps * options.fraction, 1 / 60);
  const capacity = Math.max(1, Math.round(perSecond));
  const refillIntervalMs = 1000 / perSecond;

  let tokens = capacity;
  let lastRefill = now();

  function refill(): void {
    const current = now();
    const elapsed = current - lastRefill;
    if (elapsed <= 0) {
      return;
    }
    const gained = (elapsed / 1000) * perSecond;
    if (gained >= 1) {
      tokens = Math.min(capacity, tokens + Math.floor(gained));
      lastRefill = current;
    }
  }

  return {
    async acquire(): Promise<void> {
      for (;;) {
        refill();
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        await sleep(refillIntervalMs);
      }
    },
  };
}
