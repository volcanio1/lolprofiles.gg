import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PlayerSuggestion } from '../api/types';
import {
  SUGGESTION_DEBOUNCE_MS,
  usePlayerSuggestions,
  type DebounceScheduler,
  type SuggestionFetcher,
} from './usePlayerSuggestions';

/** A scheduler the test fires by hand; cancelled entries are skipped. */
function manualScheduler() {
  const entries: { run: () => void; cancelled: boolean }[] = [];
  const schedule: DebounceScheduler = (_ms, run) => {
    const entry = { run, cancelled: false };
    entries.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return {
    schedule,
    pendingCount: () => entries.filter((e) => !e.cancelled).length,
    fireAll: () => {
      const due = entries.splice(0).filter((e) => !e.cancelled);
      for (const entry of due) {
        entry.run();
      }
    },
  };
}

/** A fetcher whose every call is resolved by the test. */
function deferredFetcher() {
  const calls: { query: string; signal?: AbortSignal; resolve: (rows: PlayerSuggestion[]) => void }[] = [];
  const fetchSuggestions: SuggestionFetcher = (query, options) =>
    new Promise((resolve) => {
      calls.push({ query, signal: options.signal, resolve });
    });
  return {
    calls,
    fetchSuggestions,
    settle: async (index: number, rows: PlayerSuggestion[]) => {
      await act(async () => {
        calls[index].resolve(rows);
        await Promise.resolve();
      });
    },
  };
}

const row = (gameName: string): PlayerSuggestion => ({ gameName, tagLine: 'NA1', profileIconId: 1, region: 'na1' });

describe('usePlayerSuggestions', () => {
  it('exposes the documented debounce interval', () => {
    expect(SUGGESTION_DEBOUNCE_MS).toBe(200);
  });

  it('issues at most one request per debounce interval across rapid typing (Requirement 3.2)', async () => {
    const timer = manualScheduler();
    const fetcher = deferredFetcher();
    const { rerender } = renderHook(({ q }) => usePlayerSuggestions(q, { schedule: timer.schedule, fetchSuggestions: fetcher.fetchSuggestions }), {
      initialProps: { q: 'fa' },
    });

    rerender({ q: 'fak' });
    rerender({ q: 'fake' });
    rerender({ q: 'faker' });

    expect(fetcher.calls).toHaveLength(0);
    expect(timer.pendingCount()).toBe(1);

    act(() => {
      timer.fireAll();
    });

    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0].query).toBe('faker');
  });

  it('never sets a timer or a list below MIN_QUERY_LENGTH (Requirement 3.2)', async () => {
    const timer = manualScheduler();
    const fetcher = deferredFetcher();
    const { result, rerender } = renderHook(
      ({ q }) => usePlayerSuggestions(q, { schedule: timer.schedule, fetchSuggestions: fetcher.fetchSuggestions }),
      { initialProps: { q: 'f' } },
    );

    expect(timer.pendingCount()).toBe(0);
    expect(result.current.suggestions).toEqual([]);

    // Grow past the threshold, then shrink back below it.
    rerender({ q: 'fa' });
    act(() => {
      timer.fireAll();
    });
    await fetcher.settle(0, [row('Faker')]);
    expect(result.current.suggestions).toEqual([row('Faker')]);

    rerender({ q: 'f' });
    expect(result.current.suggestions).toEqual([]);
    expect(timer.pendingCount()).toBe(0);
  });

  it('does not query once the value contains a #', () => {
    const timer = manualScheduler();
    const fetcher = deferredFetcher();
    renderHook(() => usePlayerSuggestions('faker#kr', { schedule: timer.schedule, fetchSuggestions: fetcher.fetchSuggestions }));

    expect(timer.pendingCount()).toBe(0);
    expect(fetcher.calls).toHaveLength(0);
  });

  it('ignores a stale response that resolves after a newer query (Requirement 3.4)', async () => {
    const timer = manualScheduler();
    const fetcher = deferredFetcher();
    const { result, rerender } = renderHook(
      ({ q }) => usePlayerSuggestions(q, { schedule: timer.schedule, fetchSuggestions: fetcher.fetchSuggestions }),
      { initialProps: { q: 'fa' } },
    );

    act(() => {
      timer.fireAll();
    });
    expect(fetcher.calls).toHaveLength(1); // for 'fa'

    rerender({ q: 'chov' });
    act(() => {
      timer.fireAll();
    });
    expect(fetcher.calls).toHaveLength(2); // for 'chov'

    // The first request's abort signal was tripped when the query changed.
    expect(fetcher.calls[0].signal?.aborted).toBe(true);

    await fetcher.settle(0, [row('Faker')]); // stale — must not land
    expect(result.current.suggestions).toEqual([]);

    await fetcher.settle(1, [row('Chovy')]); // current — applies
    expect(result.current.suggestions).toEqual([row('Chovy')]);
  });

  it('clear() empties the list without a request and invalidates an in-flight one', async () => {
    const timer = manualScheduler();
    const fetcher = deferredFetcher();
    const { result } = renderHook(() =>
      usePlayerSuggestions('faker', { schedule: timer.schedule, fetchSuggestions: fetcher.fetchSuggestions }),
    );

    act(() => {
      timer.fireAll();
    });
    await fetcher.settle(0, [row('Faker')]);
    expect(result.current.suggestions).toEqual([row('Faker')]);

    act(() => {
      result.current.clear();
    });
    expect(result.current.suggestions).toEqual([]);
    expect(fetcher.calls).toHaveLength(1); // clear issued nothing new
  });

  it('aborts the in-flight request on unmount', async () => {
    const timer = manualScheduler();
    const fetcher = deferredFetcher();
    const { unmount } = renderHook(() =>
      usePlayerSuggestions('faker', { schedule: timer.schedule, fetchSuggestions: fetcher.fetchSuggestions }),
    );

    act(() => {
      timer.fireAll();
    });
    expect(fetcher.calls).toHaveLength(1);

    unmount();
    expect(fetcher.calls[0].signal?.aborted).toBe(true);
  });
});
