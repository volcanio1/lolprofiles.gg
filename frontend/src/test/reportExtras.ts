import type {
  PremadeEntry,
  ProfileReport,
  ProfileStats,
  QueueFilterValue,
  RolePerformanceEntry,
} from '../api/types';

const QUEUE_FILTER_VALUES: readonly QueueFilterValue[] = [
  'all',
  'ranked solo/duo',
  'ranked flex',
  'normal',
];

/**
 * The per-queue fields the profile-sidebar spec added to `ProfileReport`, derived
 * from a base `stats` so a test fixture stays terse. Every slice points at the
 * same `stats` (matching the real backend, where `statsByQueue.all === stats`)
 * and role performance / rank history default empty — the panels that read them
 * have their own dedicated tests.
 */
export function perQueueReportFields(
  stats: ProfileStats,
): Pick<ProfileReport, 'statsByQueue' | 'rolePerformanceByQueue' | 'premadesByQueue' | 'rankHistory'> {
  const statsByQueue = {} as Record<QueueFilterValue, ProfileStats>;
  const rolePerformanceByQueue = {} as Record<QueueFilterValue, RolePerformanceEntry[]>;
  const premadesByQueue = {} as Record<QueueFilterValue, PremadeEntry[]>;
  for (const value of QUEUE_FILTER_VALUES) {
    statsByQueue[value] = stats;
    rolePerformanceByQueue[value] = [];
    premadesByQueue[value] = [];
  }
  return { statsByQueue, rolePerformanceByQueue, premadesByQueue, rankHistory: [] };
}
