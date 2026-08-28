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
