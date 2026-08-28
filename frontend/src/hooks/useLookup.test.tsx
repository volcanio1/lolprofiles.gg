import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LookupOutcome, LookupRequest } from '../api/lookupClient';
import type { ApiErrorPayload, ProfileReport } from '../api/types';
import { perQueueReportFields } from '../test/reportExtras';
import { MAX_RETRIES, MIN_COOLDOWN_SECONDS, useLookup, type Scheduler } from './useLookup';

/**
 * The lookup function, the clock and the scheduler are all injected, so these
 * tests never touch a network and never wait on real time.
 */

function sampleReport(): ProfileReport {
  const stats = { rankedByQueue: {}, overallAverageKda: 3.07, topChampions: [], mostPlayedRole: 'BOTTOM', averageMatchDurationMinutes: 28.5 };
  return {
    riotId: { gameName: 'Doffy', tagLine: 'Smile' },
    puuid: 'p-1',
    summonerLevel: 496,
    profileIconId: 7,
    resolvedPlatform: 'na1',
    usedPlatformOverride: false,
    stats,
    ...perQueueReportFields(stats),
    funFacts: [],
    limitedDataNotice: false,
    recommendations: [],
    averageMatchDurationMinutes: 30.38,
    recentMatches: [],
    lastUpdated: null,
    partialDataWarning: false,
  };
}

function error(overrides: Partial<ApiErrorPayload> = {}): ApiErrorPayload {
  return { code: 'RIOT_UNAVAILABLE', message: 'down', retriable: true, ...overrides };
}

/** A lookup whose resolution the test controls. */
function deferredLookup() {
  const calls: LookupRequest[] = [];
  let resolveNext: ((outcome: LookupOutcome) => void) | undefined;
  const lookup = (request: LookupRequest) => {
    calls.push(request);
    return new Promise<LookupOutcome>((resolve) => {
      resolveNext = resolve;
    });
  };
  return {
    calls,
    lookup,
    settle: async (outcome: LookupOutcome) => {
      await act(async () => {
        resolveNext?.(outcome);
        await Promise.resolve();
      });
    },
  };
}

/** A scheduler the test fires manually, plus a clock it advances manually. */
function fakeTime(start = 1_000) {
  let current = start;
  const pending: { at: number; run: () => void }[] = [];
  const schedule: Scheduler = (ms, onElapsed) => {
    const entry = { at: current + ms, run: onElapsed };
    pending.push(entry);
    return () => {
      const index = pending.indexOf(entry);
      if (index >= 0) {
        pending.splice(index, 1);
      }
    };
  };
  return {
    now: () => current,
    schedule,
    advance: async (ms: number) => {
      current += ms;
      const due = pending.filter((entry) => entry.at <= current);
      await act(async () => {
        for (const entry of due) {
          entry.run();
        }
        await Promise.resolve();
      });
    },
  };
}

const REQUEST: LookupRequest = { riotId: 'Doffy#Smile' };

describe('useLookup — loading lifecycle (Requirements 9.6, 9.7)', () => {
  it('is idle before anything is dispatched', () => {
    const { result } = renderHook(() => useLookup({ lookup: () => new Promise<LookupOutcome>(() => undefined) }));

    expect(result.current.status).toBe('idle');
    expect(result.current.loading).toBe(false);
  });

  it('sets loading on dispatch and clears it on success', async () => {
    const deferred = deferredLookup();
    const { result } = renderHook(() => useLookup({ lookup: deferred.lookup }));

    act(() => {
      result.current.start(REQUEST);
    });
    expect(result.current.loading).toBe(true);

    await deferred.settle({ kind: 'success', report: sampleReport() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.status).toBe('success');
    expect(result.current.report?.summonerLevel).toBe(496);
  });

  it('clears loading on an error too', async () => {
    const deferred = deferredLookup();
    const { result } = renderHook(() => useLookup({ lookup: deferred.lookup }));

    act(() => {
      result.current.start(REQUEST);
    });
    await deferred.settle({ kind: 'error', error: error({ code: 'TIMEOUT', retriable: false }) });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe('TIMEOUT');
  });

  it('clears loading even when the injected lookup rejects, so the indicator is never stranded', async () => {
    const { result } = renderHook(() =>
      useLookup({ lookup: () => Promise.reject(new Error('defect')) }),
    );

    await act(async () => {
      result.current.start(REQUEST);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.status).toBe('error');
  });
});

describe('useLookup — bounded retry (Requirement 9.3)', () => {
  it('offers a retry for a retriable error and consumes the budget', async () => {
    const deferred = deferredLookup();
    const { result } = renderHook(() => useLookup({ lookup: deferred.lookup }));

    act(() => {
      result.current.start(REQUEST);
    });
    await deferred.settle({ kind: 'error', error: error() });

    await waitFor(() => {
      expect(result.current.canRetry).toBe(true);
    });
    expect(result.current.retriesRemaining).toBe(MAX_RETRIES);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      act(() => {
        result.current.retry();
      });
      await deferred.settle({ kind: 'error', error: error() });
      await waitFor(() => {
        expect(result.current.retriesRemaining).toBe(MAX_RETRIES - attempt);
      });
    }

    // Requirement 9.3's cap of 3 is now reached.
    expect(result.current.retriesRemaining).toBe(0);
    expect(result.current.canRetry).toBe(false);
    expect(deferred.calls).toHaveLength(1 + MAX_RETRIES);
  });

  it('never retries on its own — only explicit calls dispatch a request', async () => {
    const deferred = deferredLookup();
    const { result } = renderHook(() => useLookup({ lookup: deferred.lookup }));

    act(() => {
      result.current.start(REQUEST);
    });
    await deferred.settle({ kind: 'error', error: error() });
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    expect(deferred.calls).toHaveLength(1);
  });

  it('offers no retry for a non-retriable failure (Requirement 9.5 / not found)', async () => {
    const deferred = deferredLookup();
    const { result } = renderHook(() => useLookup({ lookup: deferred.lookup }));

    act(() => {
      result.current.start(REQUEST);
    });
    await deferred.settle({ kind: 'error', error: error({ code: 'AUTH_FAILURE', retriable: false }) });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.canRetry).toBe(false);
  });

  it('resets the retry budget when a new search starts a new session', async () => {
    const deferred = deferredLookup();
    const { result } = renderHook(() => useLookup({ lookup: deferred.lookup }));

    act(() => {
      result.current.start(REQUEST);
    });
    await deferred.settle({ kind: 'error', error: error() });
    await waitFor(() => {
      expect(result.current.canRetry).toBe(true);
    });
    act(() => {
      result.current.retry();
    });
    await deferred.settle({ kind: 'error', error: error() });
    await waitFor(() => {
      expect(result.current.retriesRemaining).toBe(MAX_RETRIES - 1);
    });

    act(() => {
      result.current.start({ riotId: 'Other#EUW' });
    });
    await deferred.settle({ kind: 'error', error: error() });

    await waitFor(() => {
      expect(result.current.retriesRemaining).toBe(MAX_RETRIES);
    });
  });

  it('retries the same request, not a different one', async () => {
    const deferred = deferredLookup();
    const { result } = renderHook(() => useLookup({ lookup: deferred.lookup }));

    act(() => {
      result.current.start(REQUEST);
    });
    await deferred.settle({ kind: 'error', error: error() });
    await waitFor(() => {
      expect(result.current.canRetry).toBe(true);
    });
    act(() => {
      result.current.retry();
    });

    expect(deferred.calls[1]).toEqual(REQUEST);
  });
});

describe('useLookup — rate-limit cooldown (Requirement 9.8)', () => {
  it('disables retry for at least 5 seconds after a rate-limited response', async () => {
    const deferred = deferredLookup();
    const time = fakeTime();
    const { result } = renderHook(() =>
      useLookup({ lookup: deferred.lookup, now: time.now, schedule: time.schedule }),
    );

    act(() => {
      result.current.start(REQUEST);
    });
    await deferred.settle({
      kind: 'error',
      error: error({ code: 'RATE_LIMITED', retriable: true, retryAfterSeconds: 5 }),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    // Retriable, but gated by the cooldown.
    expect(result.current.error?.retriable).toBe(true);
    expect(result.current.canRetry).toBe(false);
    expect(result.current.cooldownSecondsRemaining).toBe(MIN_COOLDOWN_SECONDS);

    // Still blocked just before the deadline.
    await time.advance(4_000);
    expect(result.current.canRetry).toBe(false);

    await time.advance(1_000);
    await waitFor(() => {
      expect(result.current.canRetry).toBe(true);
    });
    expect(result.current.cooldownSecondsRemaining).toBe(0);
  });

  it('honors a longer cooldown than the minimum when the backend asks for one', async () => {
    const deferred = deferredLookup();
    const time = fakeTime();
    const { result } = renderHook(() =>
      useLookup({ lookup: deferred.lookup, now: time.now, schedule: time.schedule }),
    );

    act(() => {
      result.current.start(REQUEST);
    });
    await deferred.settle({
      kind: 'error',
      error: error({ code: 'RATE_LIMITED', retriable: true, retryAfterSeconds: 30 }),
    });

    await waitFor(() => {
      expect(result.current.cooldownSecondsRemaining).toBe(30);
    });
    await time.advance(29_000);
    expect(result.current.canRetry).toBe(false);
  });

  it('raises a too-short backend cooldown to the 5-second floor', async () => {
    const deferred = deferredLookup();
    const time = fakeTime();
    const { result } = renderHook(() =>
      useLookup({ lookup: deferred.lookup, now: time.now, schedule: time.schedule }),
    );

    act(() => {
      result.current.start(REQUEST);
    });
    await deferred.settle({
      kind: 'error',
      error: error({ code: 'RATE_LIMITED', retriable: true, retryAfterSeconds: 1 }),
    });

    await waitFor(() => {
      expect(result.current.cooldownSecondsRemaining).toBe(MIN_COOLDOWN_SECONDS);
    });
  });

  it('refuses a retry during the cooldown even if the action is invoked directly', async () => {
    const deferred = deferredLookup();
    const time = fakeTime();
    const { result } = renderHook(() =>
      useLookup({ lookup: deferred.lookup, now: time.now, schedule: time.schedule }),
    );

    act(() => {
      result.current.start(REQUEST);
    });
    await deferred.settle({
      kind: 'error',
      error: error({ code: 'RATE_LIMITED', retriable: true, retryAfterSeconds: 5 }),
    });
    await waitFor(() => {
      expect(result.current.canRetry).toBe(false);
    });

    act(() => {
      result.current.retry();
    });

    // The gate is the deadline, not the button's disabled attribute.
    expect(deferred.calls).toHaveLength(1);
  });
});

describe('useLookup — concurrency', () => {
  it('ignores a stale response that lands after a newer request', async () => {
    const resolvers: ((outcome: LookupOutcome) => void)[] = [];
    const lookup = () =>
      new Promise<LookupOutcome>((resolve) => {
        resolvers.push(resolve);
      });
    const { result } = renderHook(() => useLookup({ lookup }));

    act(() => {
      result.current.start({ riotId: 'First#EUW' });
    });
    act(() => {
      result.current.start({ riotId: 'Second#EUW' });
    });

    // The first (stale) lookup settles last.
    await act(async () => {
      resolvers[1]({ kind: 'success', report: { ...sampleReport(), summonerLevel: 222 } });
      await Promise.resolve();
    });
    await act(async () => {
      resolvers[0]({ kind: 'success', report: { ...sampleReport(), summonerLevel: 111 } });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.report?.summonerLevel).toBe(222);
    });
  });
});

describe('useLookup — referential stability of the defaults', () => {
  /**
   * REGRESSION GUARD. An earlier version built the default lookup inline, so
   * `start` was a new reference on every render. Any caller listing `start` in a
   * `useEffect` dependency array then re-ran that effect every render, and because
   * the effect sets state the loop never terminated — an unbounded stream of
   * requests at the backend and a pinned CPU. `ProfileReportPage` is such a caller.
   *
   * The bug surfaced as a test that HUNG rather than failed: the loop is
   * synchronous, so it starves the event loop and no test timeout can fire. These
   * assertions fail loudly instead.
   */
  it('keeps start stable across re-renders when nothing is injected', () => {
    const { result, rerender } = renderHook(() => useLookup());

    const first = result.current.start;
    rerender();
    rerender();

    expect(result.current.start).toBe(first);
  });

  it('keeps start stable when the caller passes a fresh options object each render', () => {
    const lookup = () => Promise.resolve<LookupOutcome>({ kind: 'success', report: sampleReport() });
    // A new object literal every render, holding the same function — exactly what a
    // parent component does.
    const { result, rerender } = renderHook(() => useLookup({ lookup }));

    const first = result.current.start;
    rerender();

    expect(result.current.start).toBe(first);
  });

  it('does not dispatch anything on mount or on a bare re-render', () => {
    const calls: LookupRequest[] = [];
    const lookup = (request: LookupRequest) => {
      calls.push(request);
      return Promise.resolve<LookupOutcome>({ kind: 'success', report: sampleReport() });
    };
    const { rerender } = renderHook(() => useLookup({ lookup }));

    rerender();
    rerender();

    expect(calls).toHaveLength(0);
  });
});
