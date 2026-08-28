/**
 * Tournament Refresher (clash-scouting Requirement 4).
 *
 * Fetches the Clash Tournament_Schedule on a background timer and writes it into
 * the `tournamentSchedule` cache entry. Visitor requests read that entry and do
 * without it on a miss — nothing on a request path ever calls the 10/min
 * tournaments endpoint (Requirement 4.1).
 *
 *  - 4.2: refreshes no more often than once per interval — the scheduler drives
 *    the cadence, and a `lastRefreshAt` guard covers `start` being called again
 *    or the immediate refresh racing the first tick.
 *  - 5.4: it holds no schedule state of its own — everything goes through the
 *    Cache_Store, so a cold start with an empty cache degrades exactly as a stale
 *    one does, per Requirement 4.4.
 *
 * The clock and scheduler are injected, as with every other timed component, so
 * tests drive it without real timers. Every fetch is fire-and-forget: a failed
 * or slow refresh leaves the previous cache entry in place and is retried next
 * tick.
 */

import { TTL_BY_ENDPOINT, type CacheStore } from '../cache';
import type { PlatformRoutingValue } from '../region';
import type { ClashTournamentSource } from './tournamentSource';

/** Requirement 4.2's floor. */
export const TOURNAMENT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** `(ms, run) => cancel`. Injected so tests never wait on real time. */
export type RepeatingScheduler = (ms: number, run: () => void) => () => void;

const defaultSchedule: RepeatingScheduler = (ms, run) => {
  const handle = setInterval(run, ms);
  // Node timers keep the event loop alive; a background refresher should not
  // block process exit on its own.
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as { unref: () => void }).unref();
  }
  return () => clearInterval(handle);
};

export interface TournamentRefresherOptions {
  source: ClashTournamentSource;
  cache: CacheStore;
  /** The platforms to keep a schedule cached for; the composition root supplies them. */
  platforms: readonly PlatformRoutingValue[];
  now?: () => number;
  schedule?: RepeatingScheduler;
}

export interface TournamentRefresher {
  start(intervalMs?: number): void;
  stop(): void;
}

export function createTournamentRefresher(options: TournamentRefresherOptions): TournamentRefresher {
  const { source, cache, platforms } = options;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;

  let cancel: (() => void) | null = null;
  let lastRefreshAt = Number.NEGATIVE_INFINITY;

  async function refreshOne(platform: PlatformRoutingValue): Promise<void> {
    const result = await source.getClashTournaments(platform).catch(() => null);
    if (result === null || result.kind !== 'ok') {
      return; // keep the previous entry; retried next tick
    }
    await cache
      .set(
        { endpoint: 'tournamentSchedule', routingValue: platform, params: {} },
        result.data,
        TTL_BY_ENDPOINT.tournamentSchedule,
      )
      .catch(() => undefined);
  }

  function refresh(intervalMs: number): void {
    if (now() - lastRefreshAt < intervalMs) {
      return; // Requirement 4.2: not more often than once per interval
    }
    lastRefreshAt = now();
    void Promise.all(platforms.map((platform) => refreshOne(platform)));
  }

  return {
    start(intervalMs = TOURNAMENT_REFRESH_INTERVAL_MS) {
      if (cancel !== null) {
        return; // already running
      }
      refresh(intervalMs);
      cancel = schedule(intervalMs, () => refresh(intervalMs));
    },
    stop() {
      cancel?.();
      cancel = null;
    },
  };
}
