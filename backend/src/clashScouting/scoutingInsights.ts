/**
 * Scouting Insight Engine (clash-scouting Requirement 3).
 *
 * A pure function of an assembled `ScoutingReport`: same report in, same insights
 * out (Requirement 3.8). No client, no clock, no I/O — issuing a further Riot
 * call to compute an insight is not expressible (Requirement 3.1), the same shape
 * as `insight/` and `liveGame/lobbyInsights.ts`.
 *
 *  - 3.2/3.3: `banRecommendations` — at most 5 champions, drawn from any member's
 *    Champion_Pool or Recent_Form, in the declared total order (see
 *    `compareBanCandidates`). The final champion-id key is what makes the order
 *    total, not merely a sort.
 *  - 3.4/3.5/3.6: `positionMismatches` — a member whose Declared_Position differs
 *    from their Observed_Role, skipping UNSELECTED / FILL declarations and members
 *    with an empty Recent_Form (equivalently, a null Observed_Role).
 *  - 3.7: `stackCohesion` — how many roster members appear together in at least
 *    one match across the combined Recent_Form.
 */

import type {
  BanRecommendation,
  PositionMismatch,
  RosterCard,
  ScoutingInsights,
  ScoutingReport,
} from './types';

export const MAX_BAN_RECOMMENDATIONS = 5;

interface BanCandidate {
  championId: number;
  puuid: string;
  masteryPoints: number;
  recentGames: number;
  recentWins: number;
}

/**
 * The declared total order (design.md), in strict precedence:
 *  1. recent wins on the champion, descending;
 *  2. mastery points on the champion, descending;
 *  3. recent games on the champion, descending;
 *  4. champion id, ascending — the key that makes the order total.
 */
export function compareBanCandidates(a: BanCandidate, b: BanCandidate): number {
  if (a.recentWins !== b.recentWins) {
    return b.recentWins - a.recentWins;
  }
  if (a.masteryPoints !== b.masteryPoints) {
    return b.masteryPoints - a.masteryPoints;
  }
  if (a.recentGames !== b.recentGames) {
    return b.recentGames - a.recentGames;
  }
  return a.championId - b.championId;
}

function computeBanRecommendations(roster: readonly RosterCard[]): BanRecommendation[] {
  // Combined recent form: per-champion games + wins across every member.
  const recentByChampion = new Map<number, { games: number; wins: number }>();
  for (const card of roster) {
    for (const entry of card.recentForm) {
      const bucket = recentByChampion.get(entry.championId) ?? { games: 0, wins: 0 };
      bucket.games += 1;
      bucket.wins += entry.win ? 1 : 0;
      recentByChampion.set(entry.championId, bucket);
    }
  }

  // Per-champion mastery: the most-invested member, breaking a tie by smallest puuid.
  const masteryByChampion = new Map<number, { points: number; puuid: string }>();
  for (const card of roster) {
    for (const pool of card.championPool ?? []) {
      const current = masteryByChampion.get(pool.championId);
      if (
        current === undefined ||
        pool.masteryPoints > current.points ||
        (pool.masteryPoints === current.points && card.puuid < current.puuid)
      ) {
        masteryByChampion.set(pool.championId, { points: pool.masteryPoints, puuid: card.puuid });
      }
    }
  }

  // Fallback attribution for a champion seen only in recent form: the member with
  // the most games on it, tie broken by smallest puuid.
  const recentOwnerByChampion = new Map<number, { games: number; puuid: string }>();
  for (const card of roster) {
    const perChampion = new Map<number, number>();
    for (const entry of card.recentForm) {
      perChampion.set(entry.championId, (perChampion.get(entry.championId) ?? 0) + 1);
    }
    for (const [championId, games] of perChampion) {
      const current = recentOwnerByChampion.get(championId);
      if (current === undefined || games > current.games || (games === current.games && card.puuid < current.puuid)) {
        recentOwnerByChampion.set(championId, { games, puuid: card.puuid });
      }
    }
  }

  const championIds = new Set<number>([...recentByChampion.keys(), ...masteryByChampion.keys()]);
  const candidates: BanCandidate[] = [];
  for (const championId of championIds) {
    const recent = recentByChampion.get(championId) ?? { games: 0, wins: 0 };
    const mastery = masteryByChampion.get(championId);
    const owner = mastery?.puuid ?? recentOwnerByChampion.get(championId)?.puuid ?? '';
    candidates.push({
      championId,
      puuid: owner,
      masteryPoints: mastery?.points ?? 0,
      recentGames: recent.games,
      recentWins: recent.wins,
    });
  }

  candidates.sort(compareBanCandidates);
  return candidates.slice(0, MAX_BAN_RECOMMENDATIONS).map((candidate) => ({ ...candidate }));
}

function computePositionMismatches(roster: readonly RosterCard[]): PositionMismatch[] {
  const mismatches: PositionMismatch[] = [];
  for (const card of roster) {
    if (card.declaredPosition === 'UNSELECTED' || card.declaredPosition === 'FILL') {
      continue; // Requirement 3.5
    }
    if (card.observedRole === null || card.recentForm.length === 0) {
      continue; // Requirement 3.6
    }
    if (card.observedRole !== card.declaredPosition) {
      mismatches.push({
        puuid: card.puuid,
        declaredPosition: card.declaredPosition,
        observedRole: card.observedRole,
      });
    }
  }
  return mismatches;
}

/**
 * Requirement 3.7. Combine every member's Recent_Form (deduped by match id); a
 * member counts toward cohesion when they share at least one such match with
 * another roster member.
 */
function computeStackCohesion(roster: readonly RosterCard[]): number {
  const rosterPuuids = new Set(roster.map((card) => card.puuid));
  const seenMatches = new Set<string>();
  const together = new Set<string>();

  for (const card of roster) {
    for (const entry of card.recentForm) {
      if (seenMatches.has(entry.matchId)) {
        continue;
      }
      seenMatches.add(entry.matchId);
      const present = entry.participantPuuids.filter((puuid) => rosterPuuids.has(puuid));
      if (present.length >= 2) {
        for (const puuid of present) {
          together.add(puuid);
        }
      }
    }
  }

  return together.size;
}

export function computeScoutingInsights(report: ScoutingReport): ScoutingInsights {
  return {
    banRecommendations: computeBanRecommendations(report.roster),
    positionMismatches: computePositionMismatches(report.roster),
    stackCohesion: computeStackCohesion(report.roster),
  };
}
