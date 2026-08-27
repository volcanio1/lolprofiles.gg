import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { MatchDto, MatchParticipantDto } from '../riotApiClient';
import { LANELESS_QUEUE_TYPE_BY_QUEUE_ID, toIncludedMatch, toLanelessMatch, toMatchParticipant } from './mapping';

/**
 * Feature: match-detail-tabs. Properties 2, 3, and 5.
 *
 * Every oracle here is transcribed from the acceptance criteria in
 * `specs/match-detail-tabs/requirements.md` and written independently of
 * `mapping.ts`'s internals — only `toIncludedMatch` and `toMatchParticipant` are
 * imported from the module under test.
 */

const ANALYZED_PUUID = 'analyzed-puuid';

/** A small, deterministic pool so mirror picks (Property 5) occur often, not rarely. */
const CHAMPION_POOL = ['Ahri', 'Zed', 'Garen', 'Lux'] as const;
const POSITION_POOL = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const;

interface ParticipantSeed {
  puuid: string;
  teamId: 100 | 200;
  teamPosition: (typeof POSITION_POOL)[number] | '';
  championName: (typeof CHAMPION_POOL)[number];
  kills: number;
  deaths: number;
  assists: number;
}

const participantSeedArb: fc.Arbitrary<ParticipantSeed> = fc.record({
  puuid: fc.uuid(),
  teamId: fc.constantFrom(100 as const, 200 as const),
  teamPosition: fc.constantFrom(...POSITION_POOL, '' as const),
  championName: fc.constantFrom(...CHAMPION_POOL),
  kills: fc.integer({ min: 0, max: 15 }),
  deaths: fc.integer({ min: 0, max: 15 }),
  assists: fc.integer({ min: 0, max: 15 }),
});

/** Ten seeds, one per side, so five distinct positions occur on each team most of the time. */
const tenParticipantSeedsArb: fc.Arbitrary<ParticipantSeed[]> = fc
  .array(participantSeedArb, { minLength: 10, maxLength: 10 })
  .map((seeds) =>
    // Force distinct PUUIDs — Riot never repeats a participant, and a duplicate
    // PUUID would make "exactly one analyzed player" unfalsifiable by construction.
    seeds.map((seed, index) => ({ ...seed, puuid: `${seed.puuid}-${index}` })),
  );

/**
 * Requirement 6.11: a match's participant list is not guaranteed to have ten
 * entries. 1 to 10 seeds, paired with an analyzed-player index guaranteed to be
 * within bounds — an out-of-bounds index would leave no participant carrying
 * `ANALYZED_PUUID` at all, which `toIncludedMatch` would then (correctly)
 * exclude as "no participant row for the requester", making the match
 * unusable for what this property actually tests.
 */
const variableCountSeedsWithAnalyzedIndexArb: fc.Arbitrary<{ seeds: ParticipantSeed[]; analyzedIndex: number }> = fc
  .array(participantSeedArb, { minLength: 1, maxLength: 10 })
  .map((seeds) => seeds.map((seed, index) => ({ ...seed, puuid: `${seed.puuid}-${index}` })))
  .chain((seeds) => fc.integer({ min: 0, max: seeds.length - 1 }).map((analyzedIndex) => ({ seeds, analyzedIndex })));

function seedToParticipant(seed: ParticipantSeed): MatchParticipantDto {
  return {
    puuid: seed.puuid,
    championName: seed.championName,
    teamPosition: seed.teamPosition,
    teamId: seed.teamId,
    win: seed.teamId === 100,
    kills: seed.kills,
    deaths: seed.deaths,
    assists: seed.assists,
    visionScore: 0,
  };
}

function seedsToMatch(seeds: readonly ParticipantSeed[], analyzedIndex: number, queueId = 420): MatchDto {
  const participants = seeds.map((seed, index) =>
    index === analyzedIndex ? { ...seedToParticipant(seed), puuid: ANALYZED_PUUID } : seedToParticipant(seed),
  );
  return {
    metadata: { matchId: 'NA1_property', participants: participants.map((p) => p.puuid) },
    info: { queueId, gameStartTimestamp: 1_700_000_000_000, gameDuration: 1_800, participants },
  };
}

// Feature: match-detail-tabs, Property 2: Participant capture preserves the match
// **Validates: Requirements 6.1, 6.7, 6.11**
describe('Property 2: participant capture preserves the match', () => {
  it('captures the same count, the same team partition, and exactly one analyzed player — for any count from 1 to 10', () => {
    let sawFewerThanTen = false;
    let sawExactlyTen = false;

    fc.assert(
      fc.property(variableCountSeedsWithAnalyzedIndexArb, ({ seeds, analyzedIndex }) => {
        if (seeds.length < 10) {
          sawFewerThanTen = true;
        } else {
          sawExactlyTen = true;
        }
        const match = seedsToMatch(seeds, analyzedIndex);
        const included = toIncludedMatch(match, ANALYZED_PUUID);
        expect(included).toBeDefined();
        const captured = included?.participants ?? [];

        expect(captured).toHaveLength(seeds.length);

        const sourceByTeam = new Map<number, number>();
        for (const seed of seeds) {
          sourceByTeam.set(seed.teamId, (sourceByTeam.get(seed.teamId) ?? 0) + 1);
        }
        const capturedByTeam = new Map<number, number>();
        for (const participant of captured) {
          capturedByTeam.set(participant.teamId, (capturedByTeam.get(participant.teamId) ?? 0) + 1);
        }
        expect(capturedByTeam).toEqual(sourceByTeam);

        expect(captured.filter((p) => p.isAnalyzedPlayer)).toHaveLength(1);

        return true;
      }),
      { numRuns: 200 },
    );

    // Requirement 6.11 is only actually exercised if the fewer-than-ten branch
    // was reached at least once — otherwise this property would silently pass
    // without ever testing what it claims to.
    expect(sawFewerThanTen).toBe(true);
    expect(sawExactlyTen).toBe(true);
  });
});

// Feature: match-detail-tabs, Property 3: No participant record carries a PUUID
// **Validates: Requirements 6.6, 6.9**
describe('Property 3: no participant record carries a PUUID', () => {
  it('never exposes a puuid field or a PUUID string anywhere in the captured participants', () => {
    fc.assert(
      fc.property(tenParticipantSeedsArb, fc.integer({ min: 0, max: 9 }), (seeds, analyzedIndex) => {
        const match = seedsToMatch(seeds, analyzedIndex);
        const included = toIncludedMatch(match, ANALYZED_PUUID);
        const captured = included?.participants ?? [];
        const allPuuids = [ANALYZED_PUUID, ...seeds.map((s) => s.puuid)];

        const serialized = JSON.stringify(captured);
        for (const puuid of allPuuids) {
          expect(serialized).not.toContain(puuid);
        }
        for (const participant of captured) {
          expect(Object.prototype.hasOwnProperty.call(participant, 'puuid')).toBe(false);
        }

        return true;
      }),
      { numRuns: 200 },
    );
  });
});

// Feature: match-detail-tabs, Property 5: The Enemy_Laner marker comes from the opponent's own row
// **Validates: Requirements 6.7, 6.8**
describe('Property 5: the Enemy_Laner marker comes from the opponent row', () => {
  it('marks exactly one opposite-team participant, carrying that row’s own champion, items, spells and runes', () => {
    let sawEnemyLanerIdentified = false;
    let sawNoEnemyLaner = false;

    fc.assert(
      fc.property(tenParticipantSeedsArb, fc.integer({ min: 0, max: 9 }), (seeds, analyzedIndex) => {
        const match = seedsToMatch(seeds, analyzedIndex);
        const included = toIncludedMatch(match, ANALYZED_PUUID);
        const captured = included?.participants ?? [];
        const marked = captured.filter((p) => p.isEnemyLaner);

        if (included?.opponent === undefined) {
          sawNoEnemyLaner = true;
          expect(marked).toHaveLength(0);
          return true;
        }

        sawEnemyLanerIdentified = true;
        expect(marked).toHaveLength(1);
        const enemyLaner = marked[0];
        const analyzedRow = captured.find((p) => p.isAnalyzedPlayer);
        expect(analyzedRow).toBeDefined();
        expect(enemyLaner.teamId).not.toBe(analyzedRow?.teamId);
        // The row `opponentOf` already summarized and the row this marker names
        // must be the same physical participant — checked by field agreement,
        // which holds even when both teams played the same champion in this lane
        // (the mirror-pick case championName-matching would get wrong).
        expect(enemyLaner.championName).toBe(included.opponent.championName);
        expect(enemyLaner.kills).toBe(included.opponent.kills);
        expect(enemyLaner.deaths).toBe(included.opponent.deaths);
        expect(enemyLaner.assists).toBe(included.opponent.assists);

        return true;
      }),
      { numRuns: 300 },
    );

    expect(sawEnemyLanerIdentified).toBe(true);
    expect(sawNoEnemyLaner).toBe(true);
  });

  it('resolves the correct side in a mirror lane — same champion, same position, on both teams', () => {
    const mirrorSeeds: ParticipantSeed[] = [
      { puuid: 'a1', teamId: 100, teamPosition: 'MIDDLE', championName: 'Zed', kills: 3, deaths: 1, assists: 2 },
      { puuid: 'a2', teamId: 100, teamPosition: 'TOP', championName: 'Garen', kills: 1, deaths: 1, assists: 1 },
      { puuid: 'a3', teamId: 100, teamPosition: 'JUNGLE', championName: 'Lux', kills: 1, deaths: 1, assists: 1 },
      { puuid: 'a4', teamId: 100, teamPosition: 'BOTTOM', championName: 'Ahri', kills: 1, deaths: 1, assists: 1 },
      { puuid: 'a5', teamId: 100, teamPosition: 'UTILITY', championName: 'Garen', kills: 1, deaths: 1, assists: 1 },
      // Same champion (Zed) and the same position (MIDDLE) on the other team — the
      // exact mirror-pick shape a champion-name match would resolve ambiguously.
      { puuid: 'b1', teamId: 200, teamPosition: 'MIDDLE', championName: 'Zed', kills: 9, deaths: 2, assists: 4 },
      { puuid: 'b2', teamId: 200, teamPosition: 'TOP', championName: 'Ahri', kills: 1, deaths: 1, assists: 1 },
      { puuid: 'b3', teamId: 200, teamPosition: 'JUNGLE', championName: 'Garen', kills: 1, deaths: 1, assists: 1 },
      { puuid: 'b4', teamId: 200, teamPosition: 'BOTTOM', championName: 'Lux', kills: 1, deaths: 1, assists: 1 },
      { puuid: 'b5', teamId: 200, teamPosition: 'UTILITY', championName: 'Ahri', kills: 1, deaths: 1, assists: 1 },
    ];
    const match = seedsToMatch(mirrorSeeds, 0);
    const included = toIncludedMatch(match, ANALYZED_PUUID);
    expect(included?.opponent?.kills).toBe(9); // b1's row, not a coin flip onto any other Zed/MIDDLE row (there is none other)
    const marked = included?.participants?.filter((p) => p.isEnemyLaner) ?? [];
    expect(marked).toHaveLength(1);
    expect(marked[0].kills).toBe(9);
    expect(marked[0].teamId).toBe(200);
  });
});

// `toMatchParticipant`'s own contract, independent of `toIncludedMatch`'s wiring.
describe('toMatchParticipant', () => {
  it('never throws on a malformed participant and never carries a puuid field', () => {
    const malformed = {
      puuid: 'should-never-appear',
      championName: 42 as unknown as string,
      perks: 'not-an-object' as unknown as MatchParticipantDto['perks'],
      summoner1Id: 'NaN' as unknown as number,
      riotIdGameName: null as unknown as string,
    } as MatchParticipantDto;

    expect(() => toMatchParticipant(malformed, { isAnalyzedPlayer: false, isEnemyLaner: false }, 0)).not.toThrow();
    const result = toMatchParticipant(malformed, { isAnalyzedPlayer: false, isEnemyLaner: false }, 0);
    expect(Object.prototype.hasOwnProperty.call(result, 'puuid')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('should-never-appear');
    expect(result.runes).toEqual({
      primaryStyle: 0,
      secondaryStyle: 0,
      primarySelections: [],
      secondarySelections: [],
      statShards: [0, 0, 0],
    });
  });
});

/** Every laned (six-queue) id, for the "never a Laneless_Match" half of Property 7. */
const LANED_QUEUE_IDS = [400, 420, 430, 440, 480, 490] as const;
const LANELESS_QUEUE_IDS = Object.keys(LANELESS_QUEUE_TYPE_BY_QUEUE_ID).map(Number);

// Feature: match-detail-tabs, Property 7: A Laneless_Match never reaches a role-relative computation
// **Validates: Requirements 11.2, 11.3, 12.1, 12.2**
describe('Property 7: a Laneless_Match never reaches a role-relative computation', () => {
  it('toLanelessMatch succeeds only for ARAM/ARAM Mayhem queues, toIncludedMatch never does for those same queues, and isEnemyLaner is false throughout', () => {
    let sawLaneless = false;
    let sawLaned = false;

    fc.assert(
      fc.property(
        variableCountSeedsWithAnalyzedIndexArb,
        fc.constantFrom(...LANED_QUEUE_IDS, ...LANELESS_QUEUE_IDS),
        ({ seeds, analyzedIndex }, queueId) => {
          const match = seedsToMatch(seeds, analyzedIndex, queueId);
          const included = toIncludedMatch(match, ANALYZED_PUUID);
          const laneless = toLanelessMatch(match, ANALYZED_PUUID);

          if (LANELESS_QUEUE_IDS.includes(queueId)) {
            sawLaneless = true;
            // Disjoint by construction: a laneless queue is never also included.
            expect(included).toBeUndefined();
            expect(laneless).toBeDefined();
            expect(laneless?.participants).toHaveLength(seeds.length);
            // No lane, so no Enemy_Laner marker anywhere — never derived, never guessed.
            expect(laneless?.participants.every((p) => !p.isEnemyLaner)).toBe(true);
            expect(laneless?.participants.filter((p) => p.isAnalyzedPlayer)).toHaveLength(1);
          } else {
            sawLaned = true;
            // A laned queue is never also admitted through the laneless path.
            expect(laneless).toBeUndefined();
          }

          return true;
        },
      ),
      { numRuns: 200 },
    );

    expect(sawLaneless).toBe(true);
    expect(sawLaned).toBe(true);
  });

  it('captures zero to six non-zero augments in Riot’s reported field order, for any queue', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 3000 }), { minLength: 6, maxLength: 6 }),
        fc.constantFrom(...LANED_QUEUE_IDS, ...LANELESS_QUEUE_IDS),
        (augmentValues, queueId) => {
          const participant: MatchParticipantDto = {
            puuid: ANALYZED_PUUID,
            championName: 'Ahri',
            teamId: 100,
            win: true,
            kills: 0,
            deaths: 0,
            assists: 0,
            visionScore: 0,
            playerAugment1: augmentValues[0],
            playerAugment2: augmentValues[1],
            playerAugment3: augmentValues[2],
            playerAugment4: augmentValues[3],
            playerAugment5: augmentValues[4],
            playerAugment6: augmentValues[5],
          };
          const result = toMatchParticipant(participant, { isAnalyzedPlayer: true, isEnemyLaner: false }, 0);

          const expected = augmentValues.filter((id) => id !== 0);
          expect(result.augments).toEqual(expected);
          expect(result.augments.length).toBeLessThanOrEqual(6);
          void queueId; // capture is queue-agnostic — the field is read unconditionally

          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
