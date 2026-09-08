import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChampionBuildStats } from '../api/types';
import { emptyChampionBuildStats } from '../api/lookupClient';
import { useChampionBuildStats, type ChampionBuildStatsFetcher } from './useChampionBuildStats';

function stats(overrides: Partial<ChampionBuildStats> = {}): ChampionBuildStats {
  return { ...emptyChampionBuildStats('Jinx', {}), ...overrides };
}

/** A fetcher whose calls resolve/reject on demand. */
function deferredFetcher() {
  const calls: {
    championKey: string;
    filters: { role?: string; rank?: string; region?: string };
    signal?: AbortSignal;
    resolve: (s: ChampionBuildStats) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const fetcher: ChampionBuildStatsFetcher = (championKey, filters, signal) =>
    new Promise((resolve, reject) => {
      calls.push({ championKey, filters, signal, resolve, reject });
    });
  return { calls, fetcher };
}

describe('useChampionBuildStats', () => {
  it('fetches on mount and lands in ready', async () => {
    const { calls, fetcher } = deferredFetcher();
    const { result } = renderHook(() =>
      useChampionBuildStats('Jinx', { role: 'BOTTOM', rank: 'ALL', region: 'world' }, { fetchChampionBuildStats: fetcher }),
    );

    expect(result.current.status).toBe('loading');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ championKey: 'Jinx', filters: { role: 'BOTTOM' } });

    await act(async () => {
      calls[0].resolve(stats({ meta: { ...stats().meta, patch: '16.17' } }));
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data?.meta.patch).toBe('16.17');
  });

  it('issues one fetch per filter change and ignores the stale response', async () => {
    const { calls, fetcher } = deferredFetcher();
    const { result, rerender } = renderHook(
      ({ role }: { role: string }) =>
        useChampionBuildStats('Jinx', { role, rank: 'ALL', region: 'world' } as never, {
          fetchChampionBuildStats: fetcher,
        }),
      { initialProps: { role: 'BOTTOM' } },
    );

    expect(calls).toHaveLength(1);
    rerender({ role: 'MIDDLE' });
    expect(calls).toHaveLength(2);
    // the first request's signal was aborted by the second start
    expect(calls[0].signal?.aborted).toBe(true);

    // resolve the STALE one first — must be ignored
    await act(async () => {
      calls[0].resolve(stats({ champion: { key: 'Jinx', name: 'STALE' } }));
    });
    expect(result.current.data).toBeNull();

    await act(async () => {
      calls[1].resolve(stats({ champion: { key: 'Jinx', name: 'FRESH' } }));
    });
    await waitFor(() => expect(result.current.data?.champion.name).toBe('FRESH'));
  });

  it('a rejected request lands in error, and retry re-issues', async () => {
    const { calls, fetcher } = deferredFetcher();
    const { result } = renderHook(() =>
      useChampionBuildStats('Jinx', { role: 'ALL', rank: 'ALL', region: 'world' }, { fetchChampionBuildStats: fetcher }),
    );

    await act(async () => {
      calls[0].reject(new Error('500'));
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.code).toBe('NETWORK_ERROR');

    act(() => {
      result.current.retry();
    });
    expect(calls).toHaveLength(2);
    expect(result.current.status).toBe('loading');

    await act(async () => {
      calls[1].resolve(stats());
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('does not fetch for a null or empty champion key', () => {
    const { calls, fetcher } = deferredFetcher();
    const { rerender } = renderHook(
      ({ key }: { key: string | null }) =>
        useChampionBuildStats(key, { role: 'ALL', rank: 'ALL', region: 'world' }, { fetchChampionBuildStats: fetcher }),
      { initialProps: { key: null as string | null } },
    );
    expect(calls).toHaveLength(0);
    rerender({ key: '' });
    expect(calls).toHaveLength(0);
  });

  it('aborts the in-flight request on unmount', async () => {
    const { calls, fetcher } = deferredFetcher();
    const { unmount } = renderHook(() =>
      useChampionBuildStats('Jinx', { role: 'ALL', rank: 'ALL', region: 'world' }, { fetchChampionBuildStats: fetcher }),
    );
    expect(calls[0].signal?.aborted).toBe(false);
    unmount();
    expect(calls[0].signal?.aborted).toBe(true);
  });
});
