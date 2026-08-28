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

/** Requirements 6.2/6.6: `'N/A'` passes through, a number gets a `%`. */
export function formatWinRate(winRatePercent: number | 'N/A'): string {
  return winRatePercent === 'N/A' ? 'N/A' : `${String(winRatePercent)}%`;
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
