/**
 * Property test for deletion coverage of the Clash cache entry types
 * (clash-scouting task 2.3).
 *
 * `InMemoryCacheStore.deleteByPuuid` already scans every entry's key AND value
 * recursively (`cache/index.ts`), and `cache/index.property.test.ts`'s
 * Property 20 already proves that generically for `summoner`/`league`/
 * `matchIds`/`account`/`matchDetail`. This file exercises the same guarantee
 * for the two Clash entry types task 2.2 added, which that property never
 * seeds: `clashPlayers` (keyed `{ puuid, platform }`, so the subject appears
 * in both the key AND — as `ClashPlayerDto.puuid` — the value) and `clashTeam`
 * (keyed `{ teamId, platform }`, so the subject can appear ONLY in the value,
 * as one of five `ClashTeamPlayerDto.puuid`s on the roster).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createInMemoryCacheStore, TTL_BY_ENDPOINT, type InMemoryCacheStore } from '../cache';
import type { ClashPlayerDto, ClashTeamDto } from './types';

const PUUID_POOL = ['puuid-a', 'puuid-b', 'puuid-c', 'puuid-d', 'puuid-e'] as const;

interface Spec {
  target: string;
  /** Which pool members hold a `clashPlayers` registration entry. */
  registrants: string[];
  /** Each cached team's roster (a subset of the pool). */
  teams: { teamId: string; roster: string[] }[];
}

const specArb: fc.Arbitrary<Spec> = fc.record({
  target: fc.constantFrom(...PUUID_POOL),
  registrants: fc.uniqueArray(fc.constantFrom(...PUUID_POOL), { maxLength: PUUID_POOL.length }),
  teams: fc
    .array(fc.uniqueArray(fc.constantFrom(...PUUID_POOL), { minLength: 1, maxLength: 5 }), { maxLength: 3 })
    .map((rosters) => rosters.map((roster, i) => ({ teamId: `team-${String(i)}`, roster }))),
});

function clashPlayerDto(puuid: string, teamId: string): ClashPlayerDto {
  return { puuid, teamId, position: 'MIDDLE', role: 'MEMBER' };
}

function clashTeamDto(teamId: string, roster: readonly string[]): ClashTeamDto {
  return {
    id: teamId,
    tournamentId: 1,
    name: `Team ${teamId}`,
    iconId: 1,
    tier: 1,
    captain: roster[0] ?? '',
    abbreviation: 'TM',
    players: roster.map((puuid) => ({ puuid, position: 'MIDDLE' as const, role: 'MEMBER' as const })),
  };
}

async function buildStore(spec: Spec): Promise<InMemoryCacheStore> {
  const store = createInMemoryCacheStore({ now: () => 1_000 });

  for (const puuid of spec.registrants) {
    // One registration per registrant; keyed by their own puuid, value also
    // carries it (a real Clash-V1 players-by-puuid response is one array
    // entry per active registration for that puuid).
    await store.set(
      { endpoint: 'clashPlayers', routingValue: 'na1', params: { puuid } },
      [clashPlayerDto(puuid, 'some-team')],
      TTL_BY_ENDPOINT.clashPlayers,
    );
  }

  for (const team of spec.teams) {
    await store.set(
      { endpoint: 'clashTeam', routingValue: 'na1', params: { teamId: team.teamId } },
      clashTeamDto(team.teamId, team.roster),
      TTL_BY_ENDPOINT.clashTeam,
    );
  }

  return store;
}

describe('deleteByPuuid — Property 5: deletion removes the subject from every Clash entry', () => {
  // Feature: clash-scouting, Property 5: Deletion removes the subject from every Clash entry
  // **Validates: Requirement 5.6**
  it('removes clashPlayers/clashTeam entries referencing the target, leaves bystanders untouched, stays idempotent', async () => {
    await fc.assert(
      fc.asyncProperty(specArb, async (spec) => {
        const store = await buildStore(spec);
        const target = spec.target;

        const before = store.dumpForVerification();
        const expectedFound = before.some((record) => JSON.stringify(record.entry.value).includes(target));

        const result = await store.deleteByPuuid(target);

        expect(result.found).toBe(expectedFound);

        // The target appears nowhere left in the store, in any Clash entry's key or value.
        expect(JSON.stringify(store.dumpForVerification())).not.toContain(target);

        const after = new Map(store.dumpForVerification().map((r) => [r.encodedKey, r]));
        for (const priorRecord of before) {
          const referencedTarget = JSON.stringify(priorRecord.entry.value).includes(target);
          const currentRecord = after.get(priorRecord.encodedKey);
          if (referencedTarget) {
            expect(currentRecord, `${priorRecord.key.endpoint} entry for ${priorRecord.encodedKey} survived`).toBeUndefined();
          } else {
            expect(currentRecord).toBeDefined();
            expect(currentRecord!.entry).toEqual(priorRecord.entry);
          }
        }

        // Idempotent: a second call finds nothing left.
        const second = await store.deleteByPuuid(target);
        expect(second).toEqual({ found: false, removedEntryCount: 0, removedMatchDetailCount: 0 });
      }),
      {
        numRuns: 150,
        // Deterministic coverage: the target is both a registrant (key+value
        // hit on clashPlayers) and a roster member of a cached team
        // (value-only hit on clashTeam), alongside a bystander who must survive.
        examples: [
          [
            {
              target: 'puuid-a',
              registrants: ['puuid-a', 'puuid-b'],
              teams: [
                { teamId: 'team-0', roster: ['puuid-a', 'puuid-c', 'puuid-d'] },
                { teamId: 'team-1', roster: ['puuid-b', 'puuid-e'] },
              ],
            },
          ],
        ],
      },
    );
  });
});
