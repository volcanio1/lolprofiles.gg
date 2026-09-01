/**
 * Property test for the Scouting Insight Engine (clash-scouting task 1.2).
 *
 * Champion ids and mastery values are drawn from small ranges to force ties —
 * a generator that rarely collides would pass without ever exercising the
 * third and fourth ban-order tie-break keys. The championId tie-break-through
 * case design.md asks to be pinned explicitly is already covered by
 * `scoutingInsights.test.ts`'s "breaks a full tie by ascending champion id"
 * example, so it is not duplicated here.
 *
 * Recent-form matches are drawn from a small pool of SHARED match slots with a
 * fixed participant list per slot, rather than each member inventing its own
 * unrelated matchId — this is what makes Stack_Cohesion (which groups entries
 * by matchId across the whole roster) exercise real overlap instead of every
 * generated match being coincidentally unique.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { compareBanCandidates, computeScoutingInsights } from './scoutingInsights';
import type { DeclaredPosition, RecentFormEntry, RosterCard, ScoutingReport } from './types';

const PUUIDS = ['p0', 'p1', 'p2', 'p3'] as const;
const DECLARED_POSITIONS: readonly DeclaredPosition[] = [
  'UNSELECTED',
  'FILL',
  'TOP',
  'JUNGLE',
  'MIDDLE',
  'BOTTOM',
  'UTILITY',
];
const ROLES = ['', 'TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const;
/** Small range: forces championId ties across members' pools/forms. */
const CHAMPION_IDS = [1, 2, 3, 4] as const;
/** Small, coarse range: forces mastery ties. */
const MASTERY_POINTS = [0, 100, 200] as const;
const SLOT_IDS = ['s0', 's1', 's2'] as const;

const declaredPositionArb = fc.constantFrom(...DECLARED_POSITIONS);
const roleArb = fc.constantFrom(...ROLES);
const championIdArb = fc.constantFrom(...CHAMPION_IDS);
const masteryArb = fc.constantFrom(...MASTERY_POINTS);
const observedRoleArb = fc.option(roleArb, { nil: null });

/** One shared match slot: a fixed participant subset, consistent across every card that references it. */
const slotArb = fc.record({
  id: fc.constantFrom(...SLOT_IDS),
  participantPuuids: fc.uniqueArray(fc.constantFrom(...PUUIDS), { maxLength: PUUIDS.length }),
});

/** A private match, unique to one member, never overlapping anyone else. */
function privateMatchArb(puuid: string, index: number): fc.Arbitrary<RecentFormEntry> {
  return fc.record({ championId: championIdArb, win: fc.boolean(), role: roleArb }).map((rest) => ({
    matchId: `${puuid}-priv${String(index)}`,
    participantPuuids: [puuid],
    ...rest,
  }));
}

const championPoolEntryArb = fc.record({
  championId: championIdArb,
  masteryPoints: masteryArb,
  masteryLevel: fc.integer({ min: 1, max: 7 }),
});

/** The full generated world: a roster size, a shared slot layout, and each member's declarations. */
const worldArb = fc
  .record({
    rosterSize: fc.integer({ min: 2, max: 4 }),
    slots: fc.uniqueArray(slotArb, { selector: (s) => s.id, minLength: 1, maxLength: SLOT_IDS.length }),
  })
  .chain(({ rosterSize, slots }) => {
    const puuids = PUUIDS.slice(0, rosterSize);
    const memberArb = (puuid: (typeof PUUIDS)[number]) =>
      fc.record({
        declaredPosition: declaredPositionArb,
        isCaptain: fc.boolean(),
        observedRole: observedRoleArb,
        championPool: fc.option(fc.array(championPoolEntryArb, { maxLength: 2 }), { nil: null }),
        slotIncludes: fc.tuple(...slots.map(() => fc.boolean())),
        privateMatches: fc.array(privateMatchArb(puuid, 0), { maxLength: 1 }),
      }).map((member) => {
        const recentForm: RecentFormEntry[] = [];
        slots.forEach((slot, i) => {
          if (member.slotIncludes[i] && slot.participantPuuids.includes(puuid)) {
            recentForm.push({
              matchId: slot.id,
              championId: CHAMPION_IDS[i % CHAMPION_IDS.length],
              role: ROLES[i % ROLES.length],
              win: i % 2 === 0,
              participantPuuids: slot.participantPuuids,
            });
          }
        });
        return {
          puuid,
          declaredPosition: member.declaredPosition,
          isCaptain: member.isCaptain,
          riotId: null,
          rankedEntries: null,
          championPool: member.championPool,
          recentForm: [...recentForm, ...member.privateMatches],
          observedRole: member.observedRole,
        } as RosterCard;
      });
    return fc.tuple(...puuids.map(memberArb)).map((roster) => ({ roster, slots }));
  });

function toReport(roster: RosterCard[]): ScoutingReport {
  return {
    team: { id: 't', name: 'T', abbreviation: 'T', tier: 1, iconId: 0, captainPuuid: roster[0]?.puuid ?? '' },
    tournament: null,
    roster,
    insights: { banRecommendations: [], positionMismatches: [], stackCohesion: 0 },
  };
}

/** Independent oracle for the position-mismatch rule (Requirements 3.4/3.5/3.6). */
function expectedMismatches(roster: readonly RosterCard[]) {
  return roster
    .filter(
      (card) =>
        card.declaredPosition !== 'UNSELECTED' &&
        card.declaredPosition !== 'FILL' &&
        card.observedRole !== null &&
        card.recentForm.length > 0 &&
        card.observedRole !== card.declaredPosition,
    )
    .map((card) => ({ puuid: card.puuid, declaredPosition: card.declaredPosition, observedRole: card.observedRole }));
}

/** Independent oracle for Stack_Cohesion (Requirement 3.7). */
function expectedStackCohesion(roster: readonly RosterCard[]): number {
  const rosterPuuids = new Set(roster.map((c) => c.puuid));
  const together = new Set<string>();
  for (const card of roster) {
    for (const entry of card.recentForm) {
      const present = entry.participantPuuids.filter((p) => rosterPuuids.has(p));
      if (present.length >= 2) {
        present.forEach((p) => together.add(p));
      }
    }
  }
  return together.size;
}

/** Independent oracle for the ban-order candidate set and per-champion aggregates (Requirements 3.2/3.3). */
function expectedBanOrder(roster: readonly RosterCard[]): number[] {
  const games = new Map<number, number>();
  const wins = new Map<number, number>();
  const mastery = new Map<number, number>();
  const candidateIds = new Set<number>();

  for (const card of roster) {
    for (const entry of card.recentForm) {
      candidateIds.add(entry.championId);
      games.set(entry.championId, (games.get(entry.championId) ?? 0) + 1);
      if (entry.win) {
        wins.set(entry.championId, (wins.get(entry.championId) ?? 0) + 1);
      }
    }
    for (const pool of card.championPool ?? []) {
      candidateIds.add(pool.championId);
      mastery.set(pool.championId, Math.max(mastery.get(pool.championId) ?? 0, pool.masteryPoints));
    }
  }

  const candidates = [...candidateIds].map((championId) => ({
    championId,
    puuid: '',
    masteryPoints: mastery.get(championId) ?? 0,
    recentGames: games.get(championId) ?? 0,
    recentWins: wins.get(championId) ?? 0,
  }));
  candidates.sort(compareBanCandidates);
  return candidates.slice(0, 5).map((c) => c.championId);
}

describe('computeScoutingInsights — Property 4: pure and strictly ordered', () => {
  // Feature: clash-scouting, Property 4: Scouting insights are pure and follow their defined orders exactly
  // **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**
  it('is pure, orders bans exactly, bounds them at 5, and matches independent oracles for mismatches and cohesion', () => {
    fc.assert(
      fc.property(worldArb, ({ roster }) => {
        const report = toReport(roster);
        const first = computeScoutingInsights(report);
        const second = computeScoutingInsights(report);

        // 3.8: purity.
        expect(second).toEqual(first);

        // 3.2/3.3: bounded, drawn only from the union of pools/forms, no duplicate champion.
        expect(first.banRecommendations.length).toBeLessThanOrEqual(5);
        const championIds = first.banRecommendations.map((b) => b.championId);
        expect(new Set(championIds).size).toBe(championIds.length);
        const validIds = new Set<number>();
        for (const card of roster) {
          for (const entry of card.recentForm) validIds.add(entry.championId);
          for (const pool of card.championPool ?? []) validIds.add(pool.championId);
        }
        for (const id of championIds) {
          expect(validIds.has(id)).toBe(true);
        }

        // Strict total order (compareBanCandidates), matching the independent oracle exactly.
        for (let i = 1; i < first.banRecommendations.length; i += 1) {
          expect(compareBanCandidates(first.banRecommendations[i - 1], first.banRecommendations[i])).toBeLessThan(0);
        }
        expect(championIds).toEqual(expectedBanOrder(roster));

        // 3.4/3.5/3.6: position mismatches.
        expect(first.positionMismatches).toEqual(expectedMismatches(roster));

        // 3.7: stack cohesion.
        expect(first.stackCohesion).toBe(expectedStackCohesion(roster));
      }),
      { numRuns: 200 },
    );
  });
});
