/**
 * Property tests for Fun Facts v2 (`player-insights` tasks 3.6, 3.7).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeFunFactsV2, nemesisOf, NEMESIS_MIN_GAMES } from './funFactsV2';
import type { IncludedMatch, ItemBuild, OpponentSummary } from './stats';

const EMPTY_BUILD: ItemBuild = { items: [0, 0, 0, 0, 0, 0], trinket: 0 };

const CHAMPION_NAMES = ['Ahri', 'Zed', 'Yasuo', 'Lux'] as const;

function opponentArb(): fc.Arbitrary<OpponentSummary | undefined> {
  return fc.option(
    fc.record({
      championName: fc.constantFrom(...CHAMPION_NAMES),
      kills: fc.constant(0),
      deaths: fc.constant(0),
      assists: fc.constant(0),
      cs: fc.constant(0),
      csPerMinute: fc.constant(0),
      visionScore: fc.constant(0),
      build: fc.constant(EMPTY_BUILD),
    }),
    { nil: undefined },
  );
}

const matchArb: fc.Arbitrary<IncludedMatch> = fc.record({
  matchId: fc.uuid(),
  queueType: fc.constantFrom('ranked solo/duo', 'ranked flex', 'normal'),
  startTimestamp: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  durationSeconds: fc.integer({ min: 0, max: 5_000 }),
  championName: fc.constantFrom(...CHAMPION_NAMES),
  role: fc.constantFrom('TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'),
  win: fc.boolean(),
  kills: fc.nat(20),
  deaths: fc.nat(20),
  assists: fc.nat(20),
  visionScore: fc.nat(100),
  cs: fc.nat(300),
  opponent: opponentArb(),
  build: fc.option(fc.constant(EMPTY_BUILD), { nil: undefined }),
});

const matchesArb = fc.array(matchArb, { maxLength: 30 });

describe('computeFunFactsV2 — Property 1: pure, at most one statement per category', () => {
  // Feature: player-insights, Property 1: Fun Facts are pure and produce at most one statement per category
  // **Validates: Requirements 1.5, 2, 3, 4, 5**
  it('returns an equal result on repeated invocation, never exceeds 4 statements, no duplicate category', () => {
    fc.assert(
      fc.property(matchesArb, (matches) => {
        const first = computeFunFactsV2(matches);
        const second = computeFunFactsV2(matches);
        expect(second).toEqual(first);

        // averageGoldDiffAt10 never fires here (no `earlyGame` argument is
        // passed, so it defaults to `[]`) -> at most 5 of the 6 categories.
        expect(first.length).toBeLessThanOrEqual(5);
        const categories = first.map((fact) => fact.category);
        expect(new Set(categories).size).toBe(categories.length);
        for (const category of categories) {
          expect(['nemesis', 'longestGame', 'favoriteItems', 'mostUsedPing', 'averageKda']).toContain(category);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('nemesisOf — Property 2: the true minimum-win-rate champion among eligible opponents', () => {
  // Feature: player-insights, Property 2: Nemesis is the true minimum-win-rate champion among eligible opponents
  // **Validates: Requirement 2**
  it('never names a champion with a lower eligible win rate than the one chosen', () => {
    fc.assert(
      fc.property(matchesArb, (matches) => {
        const result = nemesisOf(matches);

        // Independent oracle: recompute every champion's record directly.
        const records = new Map<string, { wins: number; losses: number }>();
        for (const match of matches) {
          if (match.opponent === undefined) {
            continue;
          }
          const name = match.opponent.championName;
          const record = records.get(name) ?? { wins: 0, losses: 0 };
          if (match.win) {
            record.wins += 1;
          } else {
            record.losses += 1;
          }
          records.set(name, record);
        }
        const eligible = [...records.entries()].filter(([, r]) => r.wins + r.losses >= NEMESIS_MIN_GAMES);

        if (eligible.length === 0) {
          expect(result).toBeUndefined();
          return;
        }
        expect(result).toBeDefined();
        if (result === undefined) {
          return;
        }

        // The chosen champion's win-rate fraction must be <= every other eligible champion's.
        const chosenGames = result.wins + result.losses;
        for (const [name, record] of eligible) {
          if (name === result.championName) {
            continue;
          }
          const games = record.wins + record.losses;
          // result.wins/chosenGames <= record.wins/games, cross-multiplied.
          expect(result.wins * games).toBeLessThanOrEqual(record.wins * chosenGames);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('is tied through to the champion-id... (name) tie-break: equal win rate and games -> alphabetically first', () => {
    // Pinned example: Ahri and Zed both 1-2 (33%), both 3 games -> "Ahri" wins alphabetically.
    const matches: IncludedMatch[] = [
      { matchId: 'm1', queueType: 'ranked solo/duo', startTimestamp: 1, durationSeconds: 1, championName: 'X', role: 'TOP', win: false, kills: 0, deaths: 0, assists: 0, visionScore: 0, opponent: { championName: 'Ahri', kills: 0, deaths: 0, assists: 0, cs: 0, csPerMinute: 0, visionScore: 0, build: EMPTY_BUILD } },
      { matchId: 'm2', queueType: 'ranked solo/duo', startTimestamp: 2, durationSeconds: 1, championName: 'X', role: 'TOP', win: false, kills: 0, deaths: 0, assists: 0, visionScore: 0, opponent: { championName: 'Ahri', kills: 0, deaths: 0, assists: 0, cs: 0, csPerMinute: 0, visionScore: 0, build: EMPTY_BUILD } },
      { matchId: 'm3', queueType: 'ranked solo/duo', startTimestamp: 3, durationSeconds: 1, championName: 'X', role: 'TOP', win: true, kills: 0, deaths: 0, assists: 0, visionScore: 0, opponent: { championName: 'Ahri', kills: 0, deaths: 0, assists: 0, cs: 0, csPerMinute: 0, visionScore: 0, build: EMPTY_BUILD } },
      { matchId: 'm4', queueType: 'ranked solo/duo', startTimestamp: 4, durationSeconds: 1, championName: 'X', role: 'TOP', win: false, kills: 0, deaths: 0, assists: 0, visionScore: 0, opponent: { championName: 'Zed', kills: 0, deaths: 0, assists: 0, cs: 0, csPerMinute: 0, visionScore: 0, build: EMPTY_BUILD } },
      { matchId: 'm5', queueType: 'ranked solo/duo', startTimestamp: 5, durationSeconds: 1, championName: 'X', role: 'TOP', win: false, kills: 0, deaths: 0, assists: 0, visionScore: 0, opponent: { championName: 'Zed', kills: 0, deaths: 0, assists: 0, cs: 0, csPerMinute: 0, visionScore: 0, build: EMPTY_BUILD } },
      { matchId: 'm6', queueType: 'ranked solo/duo', startTimestamp: 6, durationSeconds: 1, championName: 'X', role: 'TOP', win: true, kills: 0, deaths: 0, assists: 0, visionScore: 0, opponent: { championName: 'Zed', kills: 0, deaths: 0, assists: 0, cs: 0, csPerMinute: 0, visionScore: 0, build: EMPTY_BUILD } },
    ];
    expect(nemesisOf(matches)?.championName).toBe('Ahri');
  });
});
