/**
 * Lookup session state: loading lifecycle, bounded retry, rate-limit cooldown,
 * and (autofill-search Requirements 9-10) seeding from a stored snapshot plus an
 * explicit Refresh.
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
 *  - autofill-search 9.9: `seedFromSnapshot` shows a stored report with no network
 *    call.
 *  - autofill-search 10.3/10.4/10.5: `refresh` re-runs a live lookup for the
 *    current Riot ID, is disabled while in flight and for `REFRESH_COOLDOWN_MS`
 *    after the displayed data was fetched, and a failed refresh leaves the report
 *    on screen (the failure surfaces as `refreshError`, not the main error state).
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. THE RETRY BUDGET IS PER LOOKUP_SESSION, AND A NEW SEARCH STARTS A NEW ONE.
 *    `start` resets the counter while `retry` consumes it.
 *
 * 2. ONLY `retriable` FAILURES OFFER A RETRY. The backend decides this; the flag
 *    is honored rather than second-guessed.
 *
 * 3. THE COOLDOWNS ARE ENFORCED AGAINST AN INJECTED CLOCK, NOT A BARE
 *    `setTimeout`. `canRetry` and `refreshDisabled` are derived from deadlines
 *    compared against `now()`; a timer only exists to provoke the re-render that
 *    re-enables the control. The gate holds even if the timer fires early, late,
 *    or not at all.
 *
 * 4. A STALE RESPONSE NEVER OVERWRITES A NEWER ONE. Each dispatch (including
 *    `refresh` and `seedFromSnapshot`) takes a sequence number and applies its
 *    result only if it is still the newest.
 *
 * 5. A FAILED REFRESH DOES NOT BLANK THE REPORT (Requirement 10.5). `refresh`
 *    runs in `'refresh'` mode: on failure it sets `refreshError` and clears
 *    `refreshing`, leaving `status`, `report`, `fetchedAt` and `source` alone. A
 *    failed initial `start` still goes to the `'error'` status as before.
 *
 * 6. `fetchedAt` IS THE FRESHNESS ANCHOR FOR BOTH THE LABEL AND THE COOLDOWN. For
 *    a snapshot it is the stored value; for a live report it is the moment the
 *    report landed in this session (`POST /api/lookup` does not return a write
 *    time). It is `null` until there is a report.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { lookupProfile, type LookupOutcome, type LookupRequest } from '../api/lookupClient';
import type { ApiErrorPayload, ProfileReport } from '../api/types';
import { REFRESH_COOLDOWN_MS } from '../domain/cachedReport';

/** Requirement 9.3. */
export const MAX_RETRIES = 3;

/** Requirement 9.8's floor. */
export const MIN_COOLDOWN_SECONDS = 5;

export type LookupStatus = 'idle' | 'loading' | 'success' | 'error';

/** Where the currently displayed report came from. */
export type ReportSource = 'live' | 'snapshot';

export interface LookupState {
  status: LookupStatus;
  report?: ProfileReport;
  error?: ApiErrorPayload;
  /** Retries consumed so far in this session (Requirement 9.3). */
  retriesUsed: number;
  /** Epoch ms before which retrying is refused (Requirement 9.8). */
  cooldownUntil: number;
  /** autofill-search Requirement 10.2: freshness anchor. `null` until there is a report. */
  fetchedAt: number | null;
  source: ReportSource | null;
  /** A background refresh is in flight; the current report stays on screen. */
  refreshing: boolean;
  /** The last refresh failed (Requirement 10.5); the previous report is still shown. */
  refreshError?: ApiErrorPayload;
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
  /** autofill-search Requirement 10.4: Refresh is unavailable while loading, refreshing, or within the cooldown. */
  refreshDisabled: boolean;
  /** Starts a NEW Lookup_Session, resetting the retry budget (decision 1). */
  start: (request: LookupRequest) => void;
  /** Consumes one retry of the current session. No-op when not permitted. */
  retry: () => void;
  /** autofill-search Requirement 9.9: show a stored report with no network call. */
  seedFromSnapshot: (request: LookupRequest, report: ProfileReport, fetchedAt: number) => void;
  /** autofill-search Requirement 10.3: re-run a live lookup for the current Riot ID and overwrite the report. */
  refresh: () => void;
}

const defaultScheduler: Scheduler = (ms, onElapsed) => {
  const handle = setTimeout(onElapsed, ms);
  return () => {
    clearTimeout(handle);
  };
};

const INITIAL_STATE: LookupState = {
  status: 'idle',
  retriesUsed: 0,
  cooldownUntil: 0,
  fetchedAt: null,
  source: null,
  refreshing: false,
};

const DEFECT_ERROR: ApiErrorPayload = {
  code: 'RIOT_UNAVAILABLE',
  message: 'Something went wrong running this lookup. Please try again.',
  retriable: true,
};

export function useLookup(options: UseLookupOptions = {}): UseLookupResult {
  const { lookup: injectedLookup, now: injectedNow, schedule: injectedSchedule } = options;

  /**
   * The defaults must be referentially stable — an inline `?? (() => …)` would
   * allocate a new function every render, making `run`/`start` new references and
   * re-firing any effect that depends on them (`ProfileReportPage` is such a
   * caller). Each is resolved through `useMemo` keyed on the injected value.
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
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    (request: LookupRequest, retriesUsed: number, mode: 'start' | 'refresh') => {
      lastRequest.current = request;
      sequence.current += 1;
      const dispatched = sequence.current;

      setState((previous) =>
        mode === 'refresh'
          ? { ...previous, refreshing: true, refreshError: undefined }
          : {
              status: 'loading',
              retriesUsed,
              cooldownUntil: previous.cooldownUntil,
              fetchedAt: null,
              source: null,
              refreshing: false,
            },
      );

      void (async () => {
        let outcome: LookupOutcome | undefined;
        try {
          outcome = await lookup(request);
        } catch {
          // `lookupProfile` is contracted never to reject; reaching here means a
          // defect in an injected lookup. It still must not strand the indicator.
        }
        if (!mounted.current || dispatched !== sequence.current) {
          return;
        }

        if (outcome?.kind === 'success') {
          setState({
            status: 'success',
            report: outcome.report,
            retriesUsed,
            cooldownUntil: 0,
            fetchedAt: now(),
            source: 'live',
            refreshing: false,
          });
          return;
        }

        const failure = outcome?.kind === 'error' ? outcome.error : DEFECT_ERROR;

        if (mode === 'refresh') {
          // Decision 5: keep the report; surface the failure separately.
          setState((previous) => ({ ...previous, refreshing: false, refreshError: failure }));
          return;
        }

        const cooldownSeconds =
          failure.code === 'RATE_LIMITED'
            ? Math.max(MIN_COOLDOWN_SECONDS, failure.retryAfterSeconds ?? 0)
            : 0;
        setState({
          status: 'error',
          error: failure,
          retriesUsed,
          cooldownUntil: cooldownSeconds > 0 ? now() + cooldownSeconds * 1000 : 0,
          fetchedAt: null,
          source: null,
          refreshing: false,
        });
      })();
    },
    [lookup, now],
  );

  const start = useCallback(
    (request: LookupRequest) => {
      run(request, 0, 'start');
    },
    [run],
  );

  const seedFromSnapshot = useCallback(
    (request: LookupRequest, report: ProfileReport, fetchedAt: number) => {
      lastRequest.current = request;
      sequence.current += 1; // decision 4: invalidate anything in flight
      setState({
        status: 'success',
        report,
        retriesUsed: 0,
        cooldownUntil: 0,
        fetchedAt,
        source: 'snapshot',
        refreshing: false,
      });
    },
    [],
  );

  const cooldownRemainingMs = Math.max(0, state.cooldownUntil - now());
  const refreshCooldownRemainingMs =
    state.fetchedAt === null ? 0 : Math.max(0, state.fetchedAt + REFRESH_COOLDOWN_MS - now());

  /**
   * Decision 3: one timer for whichever cooldown expires first; it only provokes
   * a re-render. Both `canRetry` and `refreshDisabled` are computed from the
   * deadlines, so a misbehaving timer cannot bypass either.
   */
  useEffect(() => {
    const pending = Math.max(cooldownRemainingMs, refreshCooldownRemainingMs);
    if (pending <= 0) {
      return undefined;
    }
    return schedule(pending, () => {
      setCooldownTick((tick) => tick + 1);
    });
  }, [cooldownRemainingMs, refreshCooldownRemainingMs, schedule, cooldownTick]);

  const retriesRemaining = Math.max(0, MAX_RETRIES - state.retriesUsed);

  const canRetry =
    state.status === 'error' &&
    state.error !== undefined &&
    state.error.retriable &&
    retriesRemaining > 0 &&
    cooldownRemainingMs <= 0 &&
    lastRequest.current !== undefined;

  const retry = useCallback(() => {
    if (!canRetry || lastRequest.current === undefined) {
      return;
    }
    run(lastRequest.current, state.retriesUsed + 1, 'start');
  }, [canRetry, run, state.retriesUsed]);

  const loading = state.status === 'loading';
  const refreshDisabled = loading || state.refreshing || refreshCooldownRemainingMs > 0;

  const refresh = useCallback(() => {
    if (refreshDisabled || lastRequest.current === undefined) {
      return;
    }
    run(lastRequest.current, 0, 'refresh');
  }, [refreshDisabled, run]);

  return useMemo(
    () => ({
      ...state,
      loading,
      canRetry,
      retriesRemaining,
      cooldownSecondsRemaining: Math.ceil(cooldownRemainingMs / 1000),
      refreshDisabled,
      start,
      retry,
      seedFromSnapshot,
      refresh,
    }),
    [
      state,
      loading,
      canRetry,
      retriesRemaining,
      cooldownRemainingMs,
      refreshDisabled,
      start,
      retry,
      seedFromSnapshot,
      refresh,
    ],
  );
}
