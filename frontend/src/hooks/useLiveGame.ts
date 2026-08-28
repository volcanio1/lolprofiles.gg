/**
 * Live Game polling session (live-game Requirement 5).
 *
 * Given the current Riot ID, it owns the fetch lifecycle for `/api/live-game`:
 *
 *  - **First fetch on mount / Riot ID change**, then a poll no more often than
 *    every `POLL_INTERVAL_MS` (Requirement 5.1). The interval is cleared on
 *    unmount and on a Riot ID change (Requirement 5.5).
 *  - **Game-ended detection (Requirement 5.2).** Once a lobby has been displayed,
 *    a later `not_in_game` becomes the `ended` status (keeping the last lobby so
 *    the page can still link to the finished match), rather than reverting to the
 *    plain "not in a game" state.
 *  - **`refresh()`** fetches immediately and resets the interval — used by the
 *    error state's retry action.
 *
 * `not_in_game` is never an error (Requirement 1.2). A transport/Riot failure is
 * surfaced as `error` but does NOT discard a lobby already on screen — a single
 * failed poll should not blank a game the visitor is watching.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchLiveGame as defaultFetchLiveGame, type LiveGameOutcome } from '../api/lookupClient';
import type { ApiErrorPayload, LiveGameLobby, RiotIdParts } from '../api/types';

/** Requirement 5.1: the poll floor. */
export const POLL_INTERVAL_MS = 30_000;

export type LiveGameFetcher = (riotId: RiotIdParts) => Promise<LiveGameOutcome>;

/** Injected so tests never wait on real time. `(ms, run) => cancel`. */
export type IntervalScheduler = (ms: number, run: () => void) => () => void;

export interface UseLiveGameOptions {
  fetchLiveGame?: LiveGameFetcher;
  schedule?: IntervalScheduler;
  pollIntervalMs?: number;
}

export type LiveGameStatus = 'idle' | 'loading' | 'in_game' | 'not_in_game' | 'ended' | 'error';

export interface UseLiveGameState {
  status: LiveGameStatus;
  /** The current lobby (`in_game`) or the last one seen before the game ended (`ended`). */
  lobby: LiveGameLobby | null;
  error: ApiErrorPayload | null;
  /** Fetch now and reset the poll interval. */
  refresh: () => void;
}

const defaultSchedule: IntervalScheduler = (ms, run) => {
  const handle = setInterval(run, ms);
  return () => {
    clearInterval(handle);
  };
};

export function useLiveGame(riotId: RiotIdParts | null, options: UseLiveGameOptions = {}): UseLiveGameState {
  const fetcher = useMemo(() => options.fetchLiveGame ?? defaultFetchLiveGame, [options.fetchLiveGame]);
  const schedule = useMemo(() => options.schedule ?? defaultSchedule, [options.schedule]);
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;

  const [status, setStatus] = useState<LiveGameStatus>('idle');
  const [lobby, setLobby] = useState<LiveGameLobby | null>(null);
  const [error, setError] = useState<ApiErrorPayload | null>(null);

  // `hasShownLobby` gates the game-ended transition; a ref so it does not itself
  // trigger a re-render or re-run the polling effect.
  const hasShownLobby = useRef(false);
  const requestId = useRef(0);
  // The effect installs this; `refresh` calls the latest one.
  const runFetchRef = useRef<() => void>(() => undefined);

  const key = riotId === null ? null : `${riotId.gameName}#${riotId.tagLine}`;

  useEffect(() => {
    if (riotId === null || key === null) {
      setStatus('idle');
      setLobby(null);
      setError(null);
      return;
    }

    hasShownLobby.current = false;
    let cancelled = false;
    setStatus('loading');
    setError(null);

    const runFetch = () => {
      const id = (requestId.current += 1);
      void fetcher(riotId).then((outcome) => {
        if (cancelled || id !== requestId.current) {
          return;
        }
        applyOutcome(outcome);
      });
    };

    const applyOutcome = (outcome: LiveGameOutcome) => {
      if (outcome.kind === 'in_game') {
        hasShownLobby.current = true;
        setLobby(outcome.lobby);
        setError(null);
        setStatus('in_game');
        return;
      }
      if (outcome.kind === 'not_in_game') {
        // Requirement 5.2: a game we were showing has ended.
        setError(null);
        setStatus(hasShownLobby.current ? 'ended' : 'not_in_game');
        return;
      }
      // Requirement 1.2 keeps `not_in_game` off this branch; a real failure lands
      // here and must not discard a lobby already on screen.
      setError(outcome.error);
      setStatus((current) => (current === 'in_game' || current === 'ended' ? current : 'error'));
    };

    runFetchRef.current = runFetch;
    runFetch();
    const cancelInterval = schedule(pollIntervalMs, runFetch);

    return () => {
      cancelled = true;
      cancelInterval();
    };
    // `key` is the real input; `riotId`'s object identity is not a dependency
    // (see `usePlayerSuggestions` for the same hazard). `fetcher`/`schedule` are
    // resolved through `useMemo` and are stable per injected value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fetcher, schedule, pollIntervalMs]);

  const refresh = useCallback(() => {
    runFetchRef.current();
  }, []);

  return { status, lobby, error, refresh };
}
