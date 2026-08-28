/**
 * profile-sidebar Requirement 10: turning a Rank_Snapshot into a single "how
 * high" number the graph can plot.
 *
 * PURE MODULE. No React, no I/O.
 *
 * A snapshot is `tier` + `division` + `leaguePoints`. Plotting `leaguePoints`
 * alone is wrong across a promotion (Gold IV 90 LP → Gold III 10 LP is a climb
 * but LP drops), so each snapshot collapses to a cumulative ordinal:
 *
 *   below Master:  tierRank * 400 + divisionRank * 100 + clamp(lp, 0..100)
 *   Master and up: 7 * 400 + lp            (no divisions; lp is unbounded)
 *
 * The exact scale does not matter — the graph normalises to its own viewBox. All
 * that matters is that a genuine climb always produces a higher number.
 */

import type { RankSnapshot } from '../api/types';

const TIER_RANK: Readonly<Record<string, number>> = {
  IRON: 0,
  BRONZE: 1,
  SILVER: 2,
  GOLD: 3,
  PLATINUM: 4,
  EMERALD: 5,
  DIAMOND: 6,
  MASTER: 7,
  GRANDMASTER: 8,
  CHALLENGER: 9,
};

const DIVISION_RANK: Readonly<Record<string, number>> = { IV: 0, III: 1, II: 2, I: 3 };

const APEX_FLOOR = 7 * 400;

export function rankOrdinal(snapshot: Pick<RankSnapshot, 'tier' | 'division' | 'leaguePoints'>): number {
  const tier = TIER_RANK[snapshot.tier.toUpperCase()] ?? 0;
  const lp = Number.isFinite(snapshot.leaguePoints) ? snapshot.leaguePoints : 0;

  if (tier >= TIER_RANK.MASTER) {
    return APEX_FLOOR + Math.max(0, lp);
  }
  const division = DIVISION_RANK[snapshot.division.toUpperCase()] ?? 0;
  return tier * 400 + division * 100 + Math.min(100, Math.max(0, lp));
}

/** Short label for a snapshot, e.g. `Gold II 47 LP` / `Master 1182 LP`. */
export function rankLabel(snapshot: Pick<RankSnapshot, 'tier' | 'division' | 'leaguePoints'>): string {
  const tierName = snapshot.tier
    ? snapshot.tier.charAt(0).toUpperCase() + snapshot.tier.slice(1).toLowerCase()
    : 'Unranked';
  const isApex = (TIER_RANK[snapshot.tier.toUpperCase()] ?? 0) >= TIER_RANK.MASTER;
  const division = isApex || !snapshot.division ? '' : ` ${snapshot.division}`;
  return `${tierName}${division} ${snapshot.leaguePoints} LP`;
}
