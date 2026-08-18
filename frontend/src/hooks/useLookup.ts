/**
 * Lookup session state: loading lifecycle, bounded retry, rate-limit cooldown.
 *
 * Implements:
 *  - 9.6: `loading` is true from the moment a lookup is dispatched.
 *  - 9.7: `loading` returns to false on EVERY terminal state — success, any error,
 *    and client-side timeout — because it is cleared in a `finally` that covers
 *    all of them.
 *  - 9.3: a retriable failure may be retried at most `MAX_RETRIES` times per
 *    Lookup_Session, and only by explicit visitor action. Nothing here retries on
 *    its own.
 *  - 9.8: after a rate-limited response the retry action stays disabled for at
 *    least the stated cooldown (never less than 5 seconds).
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. THE RETRY BUDGET IS PER LOOKUP_SESSION, AND A NEW SEARCH STARTS A NEW ONE.
 *    Requirement 9.3 caps retries "per Lookup_Session", so `start` resets the
 *    counter while `retry` consumes it. Editing the Riot ID and searching again is
 *    a new session and therefore a fresh budget — which is correct, since it is a
 *    different question being asked.
 *
 * 2. ONLY `retriable` FAILURES OFFER A RETRY. The backend already decides this
 *    from design.md's error table, so the flag is honored rather than
 *    second-guessed. A rejected credential or a genuinely missing player does not
 *    become available by asking again, and offering a button that cannot help is
 *    worse than not offering one.
 *
 * 3. THE COOLDOWN IS ENFORCED AGAINST AN INJECTED CLOCK, NOT A BARE `setTimeout`.
 *    `canRetry` is derived from a deadline compared against `now()`, and a timer
 *    only exists to trigger the re-render that re-enables the button. That means
 *    the gate holds even if the timer fires early, late, or not at all — a timer
 *    alone would be the only thing standing between the visitor and a request
 *    Requirement 9.8 says must wait. Both the clock and the scheduler are
 *    injected, matching every other module in this build, so tests never wait on
 *    real time.
 *
 * 4. A STALE RESPONSE NEVER OVERWRITES A NEWER ONE. Each dispatch takes a
 *    sequence number and applies its result only if it is still the newest. Without
 *    it, a slow first lookup could land after a fast second one and show the wrong
 *    player's report — the kind of bug that only appears under real latency.
 *
 * 5. AN UNMOUNTED COMPONENT IS NEVER UPDATED, so a visitor who navigates away
 *    mid-lookup does not trigger a React warning or a pointless render.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { lookupProfile, type LookupOutcome, type LookupRequest } from '../api/lookupClient';
import type { ApiErrorPayload, ProfileReport } from '../api/types';

/** Requirement 9.3. */
export const MAX_RETRIES = 3;

/** Requirement 9.8's floor. */
export const MIN_COOLDOWN_SECONDS = 5;

export type LookupStatus = 'idle' | 'loading' | 'success' | 'error';

export interface LookupState {
  status: LookupStatus;
  report?: ProfileReport;
  error?: ApiErrorPayload;
  /** Retries consumed so far in this session (Requirement 9.3). */
  retriesUsed: number;
  /** Epoch ms before which retrying is refused (Requirement 9.8). */
  cooldownUntil: number;
}

/** Injected so no test waits on wall-clock time (decision 3). */
export type Scheduler = (ms: number, onElapsed: () => void) => () => void;

export interface UseLookupOptions {
  lookup?: (request: LookupRequest) => Promise<LookupOutcome>;
  now?: () => number;
  schedule?: Scheduler;
}

export interface UseLookupResult extends LookupState {
  /** Requirement 9.6/9.7. */
  loading: boolean;
  /** True when a retry is permitted right now (Requirements 9.3, 9.8, decision 2). */
  canRetry: boolean;
  retriesRemaining: number;
  /** Whole seconds left on the cooldown, for the visitor-facing countdown. */
  cooldownSecondsRemaining: number;
  /** Starts a NEW Lookup_Session, resetting the retry budget (decision 1). */
  start: (request: LookupRequest) => void;
  /** Consumes one retry of the current session. No-op when not permitted. */
  retry: () => void;
}

const defaultScheduler: Scheduler = (ms, onElapsed) => {
  const handle = setTimeout(onElapsed, ms);
  return () => {
    clearTimeout(handle);
  };
};

const INITIAL_STATE: LookupState = { status: 'idle', retriesUsed: 0, cooldownUntil: 0 };

export function useLookup(options: UseLookupOptions = {}): UseLookupResult {
  const { lookup: injectedLookup, now: injectedNow, schedule: injectedSchedule } = options;

  /**
   * DECISION 6: THE DEFAULTS MUST BE REFERENTIALLY STABLE, NOT JUST CORRECT.
   *
   * `injectedLookup ?? ((request) => lookupProfile(request))` reads harmlessly but
   * allocates a new function on every render, which makes `run` — and therefore
   * `start` — a new reference each time. Any caller with `start` in a `useEffect`
   * dependency array then re-runs that effect on every render, and because the
   * effect sets state, the render loop never terminates: an unbounded stream of
   * requests at the backend and a pinned CPU in the browser.
   *
   * `ProfileReportPage` is exactly such a caller, so this is load-bearing rather
   * than hygienic. It was caught by a test that hung instead of failing — the loop
   * is synchronous, so it starves the event loop and no timeout can fire.
   */
  const lookup = useMemo(
    () => injectedLookup ?? ((request: LookupRequest) => lookupProfile(request)),
    [injectedLookup],
  );
  const now = useMemo(() => injectedNow ?? Date.now, [injectedNow]);
  const schedule = useMemo(() => injectedSchedule ?? defaultScheduler, [injectedSchedule]);

  const [state, setState] = useState<LookupState>(INITIAL_STATE);
  /** Forces a re-render when a cooldown expires (decision 3). */
  const [cooldownTick, setCooldownTick] = useState(0);

  const lastRequest = useRef<LookupRequest | undefined>(undefined);
  const sequence = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      // Decision 5.
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    (request: LookupRequest, retriesUsed: number) => {
      lastRequest.current = request;
      sequence.current += 1;
      const dispatched = sequence.current;

      // Requirement 9.6: the indicator appears as the request is dispatched.
      setState((previous) => ({
        status: 'loading',
        retriesUsed,
        cooldownUntil: previous.cooldownUntil,
      }));

      void (async () => {
        try {
          const outcome = await lookup(request);
          // Decision 4.
          if (!mounted.current || dispatched !== sequence.current) {
            return;
          }
          if (outcome.kind === 'success') {
            setState({ status: 'success', report: outcome.report, retriesUsed, cooldownUntil: 0 });
            return;
          }
          // Requirement 9.8: a rate limit starts a cooldown of at least 5s.
          const cooldownSeconds =
            outcome.error.code === 'RATE_LIMITED'
              ? Math.max(MIN_COOLDOWN_SECONDS, outcome.error.retryAfterSeconds ?? 0)
              : 0;
          setState({
            status: 'error',
            error: outcome.error,
            retriesUsed,
            cooldownUntil: cooldownSeconds > 0 ? now() + cooldownSeconds * 1000 : 0,
          });
        } catch {
          // `lookupProfile` is contracted never to reject, so reaching here means a
          // defect in an injected lookup. It still must not strand the indicator
          // (Requirement 9.7).
          if (!mounted.current || dispatched !== sequence.current) {
            return;
          }
          setState({
            status: 'error',
            error: {
              code: 'RIOT_UNAVAILABLE',
              message: 'Something went wrong running this lookup. Please try again.',
              retriable: true,
            },
            retriesUsed,
            cooldownUntil: 0,
          });
        }
      })();
    },
    [lookup, now],
  );

  const start = useCallback(
    (request: LookupRequest) => {
      // Decision 1: a new session, so the retry budget resets.
      run(request, 0);
    },
    [run],
  );

  const cooldownRemainingMs = Math.max(0, state.cooldownUntil - now());

  /**
   * Decision 3: the timer only provokes a re-render; `canRetry` is computed from
   * the deadline, so it cannot be bypassed by a misbehaving timer.
   */
  useEffect(() => {
    if (cooldownRemainingMs <= 0) {
      return undefined;
    }
    const cancel = schedule(cooldownRemainingMs, () => {
      setCooldownTick((tick) => tick + 1);
    });
    return cancel;
    // `cooldownTick` is a dependency so the effect re-arms if the deadline has not
    // actually passed when the timer fires early.
  }, [cooldownRemainingMs, schedule, cooldownTick]);

  const retriesRemaining = Math.max(0, MAX_RETRIES - state.retriesUsed);

  const canRetry =
    state.status === 'error' &&
    state.error !== undefined &&
    // Decision 2.
    state.error.retriable &&
    retriesRemaining > 0 &&
    cooldownRemainingMs <= 0 &&
    lastRequest.current !== undefined;

  const retry = useCallback(() => {
    if (!canRetry || lastRequest.current === undefined) {
      return;
    }
    run(lastRequest.current, state.retriesUsed + 1);
  }, [canRetry, run, state.retriesUsed]);

  return useMemo(
    () => ({
      ...state,
      loading: state.status === 'loading',
      canRetry,
      retriesRemaining,
      cooldownSecondsRemaining: Math.ceil(cooldownRemainingMs / 1000),
      start,
      retry,
    }),
    [state, canRetry, retriesRemaining, cooldownRemainingMs, start, retry],
  );
}
