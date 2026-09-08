/**
 * Display formatting for report values.
 *
 * PURE MODULE. Every value handed in here is already rounded by the backend's
 * Insight Engine to the precision its requirement specifies — these functions
 * only pad/annotate for display, never re-derive a number (see
 * `ProfileReportView`'s decision 1).
 */

/** Pads to 2 decimal places for display; does not change the value. */
export function formatKda(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

/**
 * Champion-mastery sidebar section: compact mastery-points display —
 * `181371` -> `"181.4k"`, `1231400` -> `"1.2m"`. Below 1,000 shows the exact
 * integer with no suffix.
 */
export function formatMasteryPoints(points: number): string {
  if (!Number.isFinite(points)) {
    return '0';
  }
  const abs = Math.abs(points);
  if (abs >= 1_000_000) {
    return `${(points / 1_000_000).toFixed(1)}m`;
  }
  if (abs >= 1_000) {
    return `${(points / 1_000).toFixed(1)}k`;
  }
  return String(Math.round(points));
}

/** Requirements 6.2/6.6: `'N/A'` passes through, a number gets a `%`. */
export function formatWinRate(winRatePercent: number | 'N/A'): string {
  return winRatePercent === 'N/A' ? 'N/A' : `${String(winRatePercent)}%`;
}

/**
 * champion-build-stats Requirement 5.5: a `[0, 1]` rate as a percentage to one
 * decimal place — `0.5123` -> `"51.2%"`. A non-finite input renders as `"—"`,
 * never `NaN%` / `Infinity%`.
 */
export function formatRateToPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) {
    return '—';
  }
  const clamped = Math.min(1, Math.max(0, fraction));
  return `${(clamped * 100).toFixed(1)}%`;
}

/**
 * champion-build-stats Requirement 5.1/5.3.2: a whole count with a thousands
 * separator — `12400` -> `"12,400"`. A non-finite input renders as `"—"`.
 */
export function formatGameCount(value: number): string {
  return Number.isFinite(value) ? Math.round(Math.max(0, value)).toLocaleString('en-US') : '—';
}

/**
 * autofill-search Requirement 10.2: a compact relative age for the Refresh
 * label — "just now", "3m ago", "5h ago", "2d ago". `from` and `now` are epoch
 * ms; a future or unparseable `from` reads as "just now".
 */
export function relativeAge(from: number, now: number): string {
  const seconds = Math.floor((now - from) / 1000);
  if (!Number.isFinite(seconds) || seconds < 45) {
    return 'just now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${String(Math.max(1, minutes))}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)}h ago`;
  }
  return `${String(Math.floor(hours / 24))}d ago`;
}
