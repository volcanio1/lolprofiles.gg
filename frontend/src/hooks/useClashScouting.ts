/**
 * Clash Scouting fetch session (clash-scouting task 8.1).
 *
 * Unlike `useLiveGame`, this is a one-shot fetch, not a poll: a Clash roster
 * does not change second to second the way a live lobby does, and the backend's
 * `clashPlayers`/`clashTeam` cache entries (5 minutes) already bound how often a
 * repeat visit re-fetches. It fetches once on mount / Riot ID change, and again
 * whenever `selectTeam` is called (the `multiple_teams` picker) or `refresh` is
 * called (an explicit retry from the error state).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchClashScout as defaultFetchClashScout, type ClashScoutOutcome } from '../api/lookupClient';
import type { ApiErrorPayload, ClashScoutingReport, ClashTeamSummary, RiotIdParts } from '../api/types';

export type ClashScoutingFetcher = (riotId: RiotIdParts, teamId?: string) => Promise<ClashScoutOutcome>;

export interface UseClashScoutingOptions {
  fetchClashScout?: ClashScoutingFetcher;
}

export type ClashScoutingStatus = 'idle' | 'loading' | 'report' | 'multiple_teams' | 'not_registered' | 'error';

export interface UseClashScoutingState {
  status: ClashScoutingStatus;
  report: ClashScoutingReport | null;
  teams: readonly ClashTeamSummary[];
  error: ApiErrorPayload | null;
  /** Re-issues the scouting request for a chosen team from the `multiple_teams` picker. */
  selectTeam: (teamId: string) => void;
  /** Re-issues the original request — used by the error state's retry action. */
  refresh: () => void;
}

export function useClashScouting(
  riotId: RiotIdParts | null,
  options: UseClashScoutingOptions = {},
): UseClashScoutingState {
  const fetcher = useMemo(() => options.fetchClashScout ?? defaultFetchClashScout, [options.fetchClashScout]);

  const [status, setStatus] = useState<ClashScoutingStatus>('idle');
  const [report, setReport] = useState<ClashScoutingReport | null>(null);
  const [teams, setTeams] = useState<readonly ClashTeamSummary[]>([]);
  const [error, setError] = useState<ApiErrorPayload | null>(null);

  const requestId = useRef(0);
  const key = riotId === null ? null : `${riotId.gameName}#${riotId.tagLine}`;

  const runFetch = useCallback(
    (targetTeamId?: string) => {
      if (riotId === null) {
        return;
      }
      const id = (requestId.current += 1);
      setStatus('loading');
      setError(null);
      void fetcher(riotId, targetTeamId).then((outcome) => {
        if (id !== requestId.current) {
          return;
        }
        if (outcome.kind === 'report') {
          setReport(outcome.report);
          setTeams([]);
          setStatus('report');
          return;
        }
        if (outcome.kind === 'multiple_teams') {
          setReport(null);
          setTeams(outcome.teams);
          setStatus('multiple_teams');
          return;
        }
        if (outcome.kind === 'not_registered') {
          setReport(null);
          setTeams([]);
          setStatus('not_registered');
          return;
        }
        setError(outcome.error);
        setStatus('error');
      });
    },
    [riotId, fetcher],
  );

  useEffect(() => {
    if (riotId === null) {
      setStatus('idle');
      setReport(null);
      setTeams([]);
      setError(null);
      return;
    }
    runFetch();
    // `key` is the real input; `riotId`'s object identity is not a dependency,
    // and `runFetch` is recreated only when `riotId`/`fetcher` change, both of
    // which this effect already tracks via `key` and the fetcher's own memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const selectTeam = useCallback((teamId: string) => runFetch(teamId), [runFetch]);
  const refresh = useCallback(() => runFetch(), [runFetch]);

  return { status, report, teams, error, selectTeam, refresh };
}
