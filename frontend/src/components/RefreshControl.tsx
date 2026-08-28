/**
 * autofill-search Requirement 10: the always-visible "updated N ago" label and
 * Refresh button above a profile report.
 *
 * It shows for every report — served from a snapshot or from a live lookup — and
 * the button re-runs a live lookup for the displayed Riot ID. It is disabled
 * while a refresh is in flight and for `REFRESH_COOLDOWN_MS` after the displayed
 * data was fetched (both folded into `disabled` by `useLookup`).
 */

import { useEffect, useState } from 'react';
import { relativeAge } from '../domain/format';

export interface RefreshControlProps {
  /** Epoch ms the displayed data was fetched (snapshot time, or live-receipt time). */
  fetchedAt: number | null;
  /** Requirement 10.4. */
  disabled: boolean;
  /** True while the refresh request is in flight, for the button label. */
  refreshing: boolean;
  onRefresh: () => void;
  /** Injected in tests. */
  now?: () => number;
}

export function RefreshControl({ fetchedAt, disabled, refreshing, onRefresh, now = Date.now }: RefreshControlProps) {
  // Re-render every 30s so the relative label stays roughly current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const handle = setInterval(() => {
      setTick((t) => t + 1);
    }, 30_000);
    return () => {
      clearInterval(handle);
    };
  }, []);

  return (
    <div className="report-refresh">
      <span data-testid="report-freshness" className="report-refresh-age">
        {fetchedAt === null ? 'Updated just now' : `Updated ${relativeAge(fetchedAt, now())}`}
      </span>
      <button
        type="button"
        data-testid="refresh-button"
        className="btn btn-ghost"
        disabled={disabled}
        onClick={onRefresh}
      >
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  );
}
