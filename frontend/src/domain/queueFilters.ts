/**
 * profile-sidebar Requirement 9: the Gamemode_Filter value set and its labels.
 *
 * PURE MODULE. No React, no I/O.
 */

import type { ProfileReport, QueueFilterValue, RankedQueueStanding } from '../api/types';

/** `'all'` first, then the three Allowed_Queue_Types (Requirement 9.5 — no ARAM). */
export const QUEUE_FILTER_VALUES: readonly QueueFilterValue[] = [
  'all',
  'ranked solo/duo',
  'ranked flex',
  'normal',
];

export const QUEUE_FILTER_LABELS: Readonly<Record<QueueFilterValue, string>> = {
  all: 'All queues',
  'ranked solo/duo': 'Ranked Solo/Duo',
  'ranked flex': 'Ranked Flex',
  normal: 'Normal',
};

/** Requirement 9.4: the Sidebar_Queue_Filter's initial value. */
export const SIDEBAR_QUEUE_FILTER_DEFAULT: QueueFilterValue = 'all';

/**
 * Requirement 9.1: offer only the values that actually have included matches on
 * this report — `'all'` always, plus any Allowed_Queue_Type whose per-queue slice
 * is non-empty. A slice's `topChampions` is empty exactly when it had no matches,
 * so that is the presence signal.
 *
 * The Sidebar_Queue_Filter's default (`'all'`) is included even when empty,
 * per Requirement 9.6 — the panels show their own empty-state messages rather
 * than the control silently dropping the option. (Always true for `'all'`
 * anyway, since `value === 'all'` already short-circuits the check below.)
 */
export function availableQueueFilterValues(report: ProfileReport): QueueFilterValue[] {
  return QUEUE_FILTER_VALUES.filter(
    (value) =>
      value === 'all' ||
      value === SIDEBAR_QUEUE_FILTER_DEFAULT ||
      report.statsByQueue[value].topChampions.length > 0,
  );
}

/**
 * The one ranked-standing queue to show for the selected filter (the user wants
 * a single standing, not the whole list). `'ranked flex'` maps to the flex
 * entry; everything else prefers the solo entry. Falls back to whatever ranked
 * entry *is* present so an unusual queue (e.g. `RANKED_PREMADE_5x5`) still shows.
 */
export function standingQueueFor(
  filterValue: QueueFilterValue,
  rankedByQueue: Record<string, RankedQueueStanding>,
): string | undefined {
  const preferred = filterValue === 'ranked flex' ? 'RANKED_FLEX_SR' : 'RANKED_SOLO_5x5';
  if (preferred in rankedByQueue) {
    return preferred;
  }
  const present = Object.keys(rankedByQueue);
  if (present.includes('RANKED_SOLO_5x5')) return 'RANKED_SOLO_5x5';
  if (present.includes('RANKED_FLEX_SR')) return 'RANKED_FLEX_SR';
  return present[0];
}
