/**
 * Rate Limit Manager.
 *
 * No network, no environment access, no logging. Both the clock and the sleep
 * function are injected, so behavior is deterministic and testable without real
 * timers; neither `Date.now` nor `setTimeout` is ever called inline in a logic
 * path.
 *
 * Implements:
 *  - 4.3: tracks requests per routing value against the application-level and
 *    method-level windows Riot reports in `X-App-Rate-Limit` /
 *    `X-App-Rate-Limit-Count` and `X-Method-Rate-Limit` /
 *    `X-Method-Rate-Limit-Count`.
 *  - 4.4: when sending would exceed a tracked window and the required wait is
 *    <= 30s, `reserveSlot` delays until the window allows the request.
 *  - 4.5: when the required wait would exceed 30s, `reserveSlot` throws
 *    `RateLimitExceededError` immediately, without waiting at all, so the caller
 *    can surface the rate-limit message instead of hanging.
 *
 * NOT in scope here: HTTP 429 handling. Honoring `Retry-After` and the capped
 * retry count (Requirements 4.6-4.8) belongs to the Riot API Client, because it
 * is a reaction to a response Riot already rejected rather than a pre-flight
 * reservation. This module only ever prevents requests from being sent.
 *
 * Decisions worth stating explicitly, because they define the contract:
 *
 * 1. WINDOW MODEL: sliding windows over request timestamps. Riot declares each
 *    scope's limits as `count:seconds` pairs, so a scope can hold several
 *    concurrent windows (e.g. `20:1,100:120` = 20/s AND 100/120s). Each window
 *    keeps the timestamps of the requests released under it; a request at time
 *    `t` occupies a window of duration `D` over `[t, t + D)`. That makes the
 *    required wait exactly computable: to admit one more request into a full
 *    window you must wait until enough of the oldest occupants expire, i.e.
 *    until `timestamps[count - limit] + D`. A fixed-window counter could not
 *    compute this, because it does not know when the current window started
 *    relative to Riot's own bucket boundaries.
 *
 * 2. LOCAL COUNTING IS AUTHORITATIVE BETWEEN RESPONSES. `reserveSlot` records
 *    the request locally before it is sent, so a burst of reservations issued
 *    before any response comes back cannot overshoot a window.
 *
 * 3. RECONCILIATION TAKES THE MAX. `recordResponseHeaders` never lowers a
 *    window's usage to Riot's reported count: it takes
 *    `max(localCount, riotReportedCount)`. Riot's counters can both lag (a
 *    response describes the state at the moment Riot handled it, so in-flight
 *    requests of ours are missing) and lead (another process sharing the API
 *    key consumed budget we never saw). Taking the max is the only choice that
 *    is safe in both directions; trusting Riot's count outright would let us
 *    forget requests we know we sent. Any shortfall is added as synthetic
 *    timestamps at the current time, i.e. assumed as recent as possible, which
 *    is the conservative assumption: recent requests occupy the window longest.
 *
 * 4. AN UNKNOWN SCOPE IS UNLIMITED. Before Riot has told us a scope's limits
 *    there is nothing to enforce, so `reserveSlot` returns immediately. Headers
 *    that are absent or malformed are skipped rather than throwing: a missing
 *    header simply means no tracked limit for that scope yet.
 */

/** Requirements 4.4/4.5 boundary. Exported so tests and callers stay in sync. */
export const MAX_QUEUED_WAIT_MS = 30_000;

/**
 * Minimal structural type for response headers, deliberately narrower than
 * `Headers`. The Riot API Client passes a real `fetch` `Headers` (whose `get` is
 * already case-insensitive); tests pass a trivial fake. A plain record is also
 * accepted and its names are lower-cased before lookup, so header matching is
 * case-insensitive either way.
 */
export interface HeaderGetter {
  get(name: string): string | null | undefined;
}

export type RateLimitHeaders = HeaderGetter | Record<string, string | string[] | undefined>;

export interface RateLimitManager {
  /**
   * Pre-flight reservation, called before every outgoing request. Resolves once
   * the request may be sent, having recorded it against every applicable
   * window. Delays for at most `MAX_QUEUED_WAIT_MS` in total (Requirement 4.4);
   * throws `RateLimitExceededError` without waiting when the required wait
   * exceeds that budget (Requirement 4.5).
   */
  reserveSlot(routingValue: string, method: string): Promise<void>;
  /** Reconciles tracked windows with the limits/counts Riot reported (Requirement 4.3). */
  recordResponseHeaders(routingValue: string, method: string, headers: RateLimitHeaders): void;
}

/**
 * Thrown by `reserveSlot` when clearing a tracked window would take longer than
 * `MAX_QUEUED_WAIT_MS` (Requirement 4.5).
 *
 * Carries the scope and the computed wait so the caller can report which lookup
 * was abandoned and why. It cannot carry the API key: this module never receives
 * one, and must never be given one.
 */
export class RateLimitExceededError extends Error {
  readonly routingValue: string;
  readonly method: string;
  /** Wait that would have been required, in ms. `Infinity` when the window can never admit a request. */
  readonly requiredWaitMs: number;

  constructor(routingValue: string, method: string, requiredWaitMs: number) {
    super(
      `Rate limit window for routing value "${routingValue}" method "${method}" requires a wait of ` +
        `${String(requiredWaitMs)}ms, which exceeds the ${String(MAX_QUEUED_WAIT_MS)}ms maximum.`,
    );
    this.name = 'RateLimitExceededError';
    this.routingValue = routingValue;
    this.method = method;
    this.requiredWaitMs = requiredWaitMs;
    // Restores the prototype chain under CommonJS/ES2022 down-level emit so
    // `instanceof` holds for callers and tests.
    Object.setPrototypeOf(this, RateLimitExceededError.prototype);
  }
}

/** One `count:seconds` pair from a Riot rate-limit header. */
export interface RateLimitPair {
  /** The declared limit (for a `-Limit` header) or current usage (for a `-Count` header). */
  count: number;
  /** Window duration in seconds; always > 0. */
  seconds: number;
}

/**
 * Parses Riot's comma-separated `count:seconds` pair lists, e.g. `20:1,100:120`.
 *
 * Defensive by contract: returns `[]` for absent/empty input and silently skips
 * any pair that is not two non-negative integers with a positive duration. A
 * malformed header must never break a lookup, and a partially readable header is
 * still worth tracking. Duplicate durations keep the last occurrence, since a
 * later pair is the more recent statement about that window.
 */
export function parseRateLimitPairs(raw: string | null | undefined): RateLimitPair[] {
  if (raw === null || raw === undefined) {
    return [];
  }
  const bySeconds = new Map<number, RateLimitPair>();
  for (const chunk of raw.split(',')) {
    const parts = chunk.trim().split(':');
    if (parts.length !== 2) {
      continue;
    }
    const count = parseNonNegativeInteger(parts[0]);
    const seconds = parseNonNegativeInteger(parts[1]);
    if (count === undefined || seconds === undefined || seconds === 0) {
      continue;
    }
    bySeconds.set(seconds, { count, seconds });
  }
  return [...bySeconds.values()];
}

function parseNonNegativeInteger(raw: string | undefined): number | undefined {
  const text = (raw ?? '').trim();
  if (text === '' || !/^\d+$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Case-insensitive header read that works with `Headers` and plain records
 * alike. Array values (Node's raw header shape) take the first element, which is
 * the only sensible reading for a single-valued rate-limit header.
 */
export function readHeader(headers: RateLimitHeaders, name: string): string | null {
  const getter = (headers as Partial<HeaderGetter>).get;
  if (typeof getter === 'function') {
    return getter.call(headers as HeaderGetter, name) ?? null;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== wanted) {
      continue;
    }
    if (Array.isArray(value)) {
      return value.length > 0 ? value[0] : null;
    }
    return value ?? null;
  }
  return null;
}

/** A single sliding window: `limit` requests per `durationMs`, with its occupants. */
interface SlidingWindow {
  durationMs: number;
  limit: number;
  /** Release timestamps, ascending. Pruned once outside the window. */
  timestamps: number[];
}

/** Read-only view of tracked state, for verification only. */
export interface RateLimitWindowSnapshot {
  scopeKey: string;
  durationSeconds: number;
  limit: number;
  count: number;
}

export interface RateLimitManagerOptions {
  /** Injected clock; defaults to `Date.now`. Never called inline in logic paths. */
  now?: () => number;
  /** Injected delay; defaults to a `setTimeout`-based sleep. Never called inline in logic paths. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function appScopeKey(routingValue: string): string {
  return `app|${routingValue}`;
}

function methodScopeKey(routingValue: string, method: string): string {
  return `method|${routingValue}|${method}`;
}

/**
 * In-memory `RateLimitManager`.
 *
 * One instance owns the accounting for every routing value it is asked about,
 * because Riot enforces app limits per API key per routing value and method
 * limits per (routing value, method) — so all callers sharing a key must share
 * one manager for the pre-flight check to mean anything.
 */
export class InMemoryRateLimitManager implements RateLimitManager {
  private readonly windowsByScope = new Map<string, SlidingWindow[]>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: RateLimitManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Requirements 4.3-4.5.
   *
   * Loops rather than sleeping once, because reservations made by other
   * concurrent callers during the sleep can consume the capacity this call was
   * waiting for. The remaining budget is carried across iterations, so the total
   * time spent sleeping never exceeds `MAX_QUEUED_WAIT_MS` — that, plus the fact
   * that timestamps are recorded before returning, is what makes the invariant
   * hold: no released request can push a window past its declared limit, and no
   * call blocks for longer than 30 seconds.
   */
  async reserveSlot(routingValue: string, method: string): Promise<void> {
    let sleptMs = 0;

    for (;;) {
      const now = this.now();
      const windows = this.applicableWindows(routingValue, method, now);
      const requiredWaitMs = requiredWait(windows, now);

      if (requiredWaitMs === 0) {
        for (const window of windows) {
          window.timestamps.push(now);
        }
        return;
      }

      // Requirement 4.5: fail fast rather than wait past the budget. On the
      // first iteration `sleptMs` is 0, so nothing has been waited at all.
      if (sleptMs + requiredWaitMs > MAX_QUEUED_WAIT_MS) {
        throw new RateLimitExceededError(routingValue, method, requiredWaitMs);
      }

      // Requirement 4.4.
      sleptMs += requiredWaitMs;
      await this.sleep(requiredWaitMs);
    }
  }

  /**
   * Requirement 4.3. Reconciles both scopes with the reported limits and counts.
   * Absent or malformed headers leave the corresponding scope untouched.
   */
  recordResponseHeaders(routingValue: string, method: string, headers: RateLimitHeaders): void {
    const now = this.now();
    this.reconcileScope(
      appScopeKey(routingValue),
      parseRateLimitPairs(readHeader(headers, 'X-App-Rate-Limit')),
      parseRateLimitPairs(readHeader(headers, 'X-App-Rate-Limit-Count')),
      now,
    );
    this.reconcileScope(
      methodScopeKey(routingValue, method),
      parseRateLimitPairs(readHeader(headers, 'X-Method-Rate-Limit')),
      parseRateLimitPairs(readHeader(headers, 'X-Method-Rate-Limit-Count')),
      now,
    );
  }

  /**
   * Both scopes that constrain a request: the app-level windows for the routing
   * value and the method-level windows for the (routing value, method) pair.
   * Expired timestamps are pruned here, which is the only place they need to be.
   */
  private applicableWindows(routingValue: string, method: string, now: number): SlidingWindow[] {
    const windows = [
      ...(this.windowsByScope.get(appScopeKey(routingValue)) ?? []),
      ...(this.windowsByScope.get(methodScopeKey(routingValue, method)) ?? []),
    ];
    for (const window of windows) {
      pruneExpired(window, now);
    }
    return windows;
  }

  /**
   * Replaces a scope's window set with exactly the durations Riot declared,
   * preserving the recorded timestamps of durations that carry over, then raises
   * each window's usage to Riot's reported count where that count is higher (see
   * the module docblock, decision 3).
   *
   * An empty `limits` list (absent/malformed limit header) leaves the scope as it
   * was: forgetting the limits we already know because one response omitted them
   * would be strictly less safe.
   */
  private reconcileScope(scopeKey: string, limits: RateLimitPair[], counts: RateLimitPair[], now: number): void {
    if (limits.length > 0) {
      const existing = this.windowsByScope.get(scopeKey) ?? [];
      const next = limits.map<SlidingWindow>((limit) => {
        const carried = existing.find((window) => window.durationMs === limit.seconds * 1000);
        return {
          durationMs: limit.seconds * 1000,
          limit: limit.count,
          timestamps: carried ? carried.timestamps : [],
        };
      });
      this.windowsByScope.set(scopeKey, next);
    }

    const windows = this.windowsByScope.get(scopeKey);
    if (windows === undefined) {
      return;
    }

    for (const reported of counts) {
      const window = windows.find((candidate) => candidate.durationMs === reported.seconds * 1000);
      if (window === undefined) {
        continue;
      }
      pruneExpired(window, now);
      const shortfall = reported.count - window.timestamps.length;
      for (let index = 0; index < shortfall; index += 1) {
        window.timestamps.push(now);
      }
    }
  }

  /**
   * Snapshot of tracked windows, for verification only — NOT part of the
   * `RateLimitManager` contract, and production code must not depend on it.
   */
  snapshotForVerification(): RateLimitWindowSnapshot[] {
    const now = this.now();
    const snapshot: RateLimitWindowSnapshot[] = [];
    for (const [scopeKey, windows] of this.windowsByScope) {
      for (const window of windows) {
        pruneExpired(window, now);
        snapshot.push({
          scopeKey,
          durationSeconds: window.durationMs / 1000,
          limit: window.limit,
          count: window.timestamps.length,
        });
      }
    }
    return snapshot;
  }
}

/**
 * Drops timestamps that no longer occupy the window. A request at `t` occupies
 * `[t, t + D)`, so it is expired once `t + D <= now`.
 */
function pruneExpired(window: SlidingWindow, now: number): void {
  if (window.timestamps.length === 0) {
    return;
  }
  const cutoff = now - window.durationMs;
  let firstLive = 0;
  while (firstLive < window.timestamps.length && window.timestamps[firstLive] <= cutoff) {
    firstLive += 1;
  }
  if (firstLive > 0) {
    window.timestamps.splice(0, firstLive);
  }
}

/**
 * Wait needed before one more request may be released under every window: the
 * maximum over windows, and 0 when they all have capacity.
 *
 * For a full window, the request becomes admissible once `count - limit + 1` of
 * the oldest occupants have expired, i.e. at `timestamps[count - limit] + D`.
 * A window with a non-positive limit can never admit a request, so its wait is
 * `Infinity` — which fails the 30s budget and therefore fails fast.
 */
function requiredWait(windows: readonly SlidingWindow[], now: number): number {
  let waitMs = 0;
  for (const window of windows) {
    if (window.limit <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    const count = window.timestamps.length;
    if (count < window.limit) {
      continue;
    }
    const expiringAt = window.timestamps[count - window.limit] + window.durationMs;
    waitMs = Math.max(waitMs, expiringAt - now);
  }
  return waitMs > 0 ? waitMs : 0;
}

export function createRateLimitManager(options: RateLimitManagerOptions = {}): InMemoryRateLimitManager {
  return new InMemoryRateLimitManager(options);
}
