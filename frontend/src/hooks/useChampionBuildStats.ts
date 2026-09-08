/**
 * Champion build-stats fetch session (champion-build-stats task 11).
 *
 * One-shot fetch, no poll: aggregates change on the backend's own schedule
 * (Requirement 8.3), so there is nothing to poll for. It fetches on mount with a
 * valid `Champion_Key` and again whenever `role` / `rank` / `region` changes
 * (Requirement 4.1), or when `retry` is called from the error state
 * (Requirement 4.4).
 *
 *  - Requirement 4.3: a monotonic `requestId` (the same guard `useLookup` uses)
 *    drops a stale response — an older request that resolves late, or any
 *    response for a filter set that has since changed.
 *  - Requirement 4.5: an absent / empty `Champion_Key` issues no request. The
 *    page short-circuits an unknown key before rendering the hook's states.
 *  - Requirement 4.4: a failed request (transport, non-2xx, unparseable —
 *    `fetchChampionBuildStats` rejects on all three) lands in `error`, leaving no
 *    spinner running; `retry` re-issues.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchChampionBuildStats as defaultFetchChampionBuildStats,
  synthesizedError,
  type ChampionStatsFilters,
} from '../api/lookupClient';
import type { ApiErrorPayload, ChampionBuildStats } from '../api/types';

export type ChampionBuildStatsFetcher = (
  championKey: string,
  filters: ChampionStatsFilters,
  signal?: AbortSignal,
) => Promise<ChampionBuildStats>;

export interface UseChampionBuildStatsOptions {
  fetchChampionBuildStats?: ChampionBuildStatsFetcher;
}

export type ChampionBuildStatsStatus = 'loading' | 'ready' | 'error';

export interface UseChampionBuildStatsState {
  data: ChampionBuildStats | null;
  status: ChampionBuildStatsStatus;
  error: ApiErrorPayload | null;
  retry: () => void;
}

export function useChampionBuildStats(
  championKey: string | null,
  filters: ChampionStatsFilters,
  options: UseChampionBuildStatsOptions = {},
): UseChampionBuildStatsState {
  const fetcher = useMemo(
    () =>
      options.fetchChampionBuildStats ??
      ((key: string, f: ChampionStatsFilters, signal?: AbortSignal) =>
        defaultFetchChampionBuildStats(key, f, { signal })),
    [options.fetchChampionBuildStats],
  );

  const [data, setData] = useState<ChampionBuildStats | null>(null);
  const [status, setStatus] = useState<ChampionBuildStatsStatus>('loading');
  const [error, setError] = useState<ApiErrorPayload | null>(null);

  const requestId = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The `filters` object identity changes every render; only the three values matter.
  const role = filters.role;
  const rank = filters.rank;
  const region = filters.region;

  const start = useCallback(() => {
    if (championKey === null || championKey.length === 0) {
      return;
    }
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const id = (requestId.current += 1);

    setError(null);
    setStatus('loading');

    void fetcher(championKey, { role, rank, region }, controller.signal).then(
      (stats) => {
        if (!mounted.current || id !== requestId.current) {
          return;
        }
        setData(stats);
        setStatus('ready');
      },
      () => {
        if (!mounted.current || id !== requestId.current || controller.signal.aborted) {
          return;
        }
        setError(synthesizedError('NETWORK_ERROR'));
        setStatus('error');
      },
    );
  }, [championKey, role, rank, region, fetcher]);

  useEffect(() => {
    start();
    return () => {
      activeController.current?.abort();
    };
  }, [start]);

  return { data, status, error, retry: start };
}
