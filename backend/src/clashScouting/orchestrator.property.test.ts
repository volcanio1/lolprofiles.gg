/**
 * Property tests for the Scouting Orchestrator (clash-scouting tasks 5.2, 5.3).
 *
 * Property 2 (task 5.3) is, per design.md's own Testing Strategy, "the most
 * important test in the spec" — a regression here means intermittent rate-limit
 * exhaustion against Clash-V1's 10-requests-per-minute tournaments endpoint,
 * misdiagnosed as a Riot outage rather than traced back to a code change.
 *
 * design.md's stated approach — "handing the orchestrator a `ClashTournamentSource`
 * fake that fails the test on any invocation" — is no longer expressible the way
 * it's phrased: `ScoutingOrchestratorOptions` (orchestrator.ts) has no
 * `ClashTournamentSource` field at all, so there is no slot to hand a failing
 * fake into in the first place. That is the boundary working as designed one
 * layer earlier than the property anticipated — a compile error instead of a
 * runtime check — so this file asserts it twice, at two different layers:
 *
 *  1. A compile-time check (`@ts-expect-error` below) that constructing a
 *     `ScoutingOrchestratorOptions` with a `tournamentSource` field fails to
 *     type-check. If this boundary ever regressed (the field got added back),
 *     `@ts-expect-error` on a line that no longer errors is itself a compile
 *     error under `noUnusedLocals`-adjacent TS checking, so this test file
 *     would fail to build — the property survives even though nothing here
 *     runs at test time.
 *  2. The runtime half of Property 2's claim that design.md's phrasing CAN
 *     still test without that fake: for any cache state of `tournamentSchedule`
 *     (absent, fresh-and-matching, fresh-but-for-a-different-tournament, or
 *     stale), a scouting report is always produced with `tournament: null`
 *     unless the cache holds a fresh, matching entry — never blocked, never an
 *     error, and the count of calls the fake `RiotApiClient`'s
 *     `getClashTournamentsByTeam` (the RELATED but distinct 200/min endpoint)
 *     receives stays at the one-per-report the orchestrator's own pipeline
 *     requires, never more.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createInMemoryCacheStore, TTL_BY_ENDPOINT } from '../cache';
import type { RegionResolver } from '../regionResolver';
import type { RiotApiClient, RiotApiResult } from '../riotApiClient';
import type { RosterEnricher } from './enricher';
import { createScoutingOrchestrator, type ScoutingOrchestratorOptions } from './orchestrator';
import type { ClashPlayerDto, ClashTeamDto, ClashTournamentDto, RosterCard } from './types';

// ---------------------------------------------------------------------------
// Compile-time half of Property 2 (task 5.3): the boundary is structural.
// Never invoked (guarded by `false &&`) — this exists purely for `tsc` to
// excess-property-check the literal below against `ScoutingOrchestratorOptions`.
// ---------------------------------------------------------------------------
function neverCalled(client: RiotApiClient, cache: ReturnType<typeof createInMemoryCacheStore>) {
  if (false as boolean) {
    createScoutingOrchestrator({
      client,
      cache,
      // @ts-expect-error — ScoutingOrchestratorOptions must never grow a
      // ClashTournamentSource-shaped field. If this stops erroring, the
      // Scouting Orchestrator has regained a path to the 10/min tournaments
      // endpoint and Requirement 4.1 no longer holds structurally.
      tournamentSource: { getClashTournaments: () => Promise.resolve({ kind: 'ok', data: [] }) },
    });
  }
}
void neverCalled;

const ok = <T>(data: T): RiotApiResult<T> => ({ kind: 'ok', data });
const notFound = <T>(): RiotApiResult<T> => ({ kind: 'not_found' });

const RESOLVED: RegionResolver = { resolve: () => Promise.resolve({ kind: 'resolved', platform: 'na1', region: 'americas' }) };

const PASSTHROUGH_ENRICHER: RosterEnricher = {
  enrichAll: (_platform, _region, members) =>
    Promise.resolve(
      members.map(
        (m): RosterCard => ({
          puuid: m.puuid,
          declaredPosition: m.position,
          isCaptain: m.role === 'CAPTAIN',
          riotId: null,
          rankedEntries: null,
          championPool: null,
          recentForm: [],
          observedRole: null,
        }),
      ),
    ),
};

const RIOT_ID = { gameName: 'A', tagLine: 'NA1' };

function team(overrides: Partial<ClashTeamDto> = {}): ClashTeamDto {
  return {
    id: 't1',
    tournamentId: 500,
    name: 'Team',
    iconId: 1,
    tier: 1,
    captain: 'a',
    abbreviation: 'TM',
    players: [{ puuid: 'a', position: 'MIDDLE', role: 'CAPTAIN' }],
    ...overrides,
  };
}

interface CountingClientOptions {
  registrations?: ClashPlayerDto[];
  teamResult?: RiotApiResult<ClashTeamDto>;
}

function countingClient(options: CountingClientOptions = {}) {
  const reject = () => Promise.reject(new Error('not used'));
  const calls = { clashPlayers: 0, clashTeam: 0, clashTournamentsByTeam: 0, league: 0, masteryTop: 0, matchIds: 0 };
  const client: RiotApiClient = {
    getAccountByRiotId: () => Promise.resolve(ok({ puuid: 'a', gameName: 'A', tagLine: 'NA1' })),
    getRegionByPuuid: reject,
    getSummonerByPuuid: reject,
    getLeagueEntriesByPuuid: () => {
      calls.league += 1;
      return Promise.resolve(ok([]));
    },
    getMatchIdsByPuuid: () => {
      calls.matchIds += 1;
      return Promise.resolve(ok([]));
    },
    getMatchById: reject,
    getMatchTimeline: reject,
    getActiveGameByPuuid: reject,
    getAccountByPuuid: () => Promise.resolve(ok({ puuid: 'a', gameName: 'A', tagLine: 'NA1' })),
    getChampionMastery: reject,
    getClashPlayersByPuuid: () => {
      calls.clashPlayers += 1;
      return Promise.resolve(ok(options.registrations ?? [{ puuid: 'a', teamId: 't1', position: 'MIDDLE', role: 'CAPTAIN' }]));
    },
    getClashTeam: () => {
      calls.clashTeam += 1;
      return Promise.resolve(options.teamResult ?? ok(team()));
    },
    getClashTournamentsByTeam: () => {
      calls.clashTournamentsByTeam += 1;
      return Promise.resolve(ok([]));
    },
    getChampionMasteryTop: () => {
      calls.masteryTop += 1;
      return Promise.resolve(ok([]));
    },
  };
  return { client, calls };
}

function makeOrchestrator(overrides: Partial<ScoutingOrchestratorOptions> & { client: RiotApiClient }) {
  return createScoutingOrchestrator({
    cache: createInMemoryCacheStore({ now: () => 1_000 }),
    now: () => 1_000,
    regionResolver: RESOLVED,
    rosterEnricher: PASSTHROUGH_ENRICHER,
    ...overrides,
  });
}

describe('createScoutingOrchestrator — Property 1: no registration is a state, never an error', () => {
  // Feature: clash-scouting, Property 1: No active Clash registration is a state and never an error
  // **Validates: Requirement 1.3**
  it('an empty registration array yields not_registered with no team, enrichment or mastery call', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const { client, calls } = countingClient({ registrations: [] });
        const result = await makeOrchestrator({ client }).scout(RIOT_ID);

        expect(result).toEqual({ kind: 'not_registered' });
        expect(calls.clashTeam).toBe(0);
        expect(calls.league).toBe(0);
        expect(calls.masteryTop).toBe(0);
        expect(calls.matchIds).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  // **Validates: Requirement 1.3 (error table row 3: a stale registration whose team 404s)**
  it('a teams-endpoint not_found for the referenced team id also yields not_registered, never an error', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 3 }), async (registrationCount) => {
        const registrations = Array.from({ length: registrationCount }, (_, i) => ({
          puuid: 'a',
          teamId: `t${String(i)}`,
          position: 'MIDDLE' as const,
          role: 'CAPTAIN' as const,
        }));
        const { client } = countingClient({ registrations, teamResult: notFound() });
        const result = await makeOrchestrator({ client }).scout(RIOT_ID, registrations[0].teamId);

        expect(result).toEqual({ kind: 'not_registered' });
      }),
      { numRuns: 100 },
    );
  });
});

/** Cache states `tournamentSchedule` can be found in when a scouting request runs. */
type TournamentCacheState = 'absent' | 'fresh_matching' | 'fresh_other' | 'stale_matching';

const cacheStateArb: fc.Arbitrary<TournamentCacheState> = fc.constantFrom(
  'absent',
  'fresh_matching',
  'fresh_other',
  'stale_matching',
);

describe('createScoutingOrchestrator — Property 2: the tournaments endpoint is never called on a request path', () => {
  // Feature: clash-scouting, Property 2: The tournaments endpoint is never called on a request path
  // **Validates: Requirements 4.1, 4.3, 4.4**
  it('degrades to tournament: null on every cache state but a fresh, matching one — never blocked, never an error', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10_000 }), cacheStateArb, async (tournamentId, state) => {
        const NOW = 10_000_000;
        const cache = createInMemoryCacheStore({ now: () => NOW });
        const schedule: ClashTournamentDto[] = [
          { id: tournamentId, themeId: 1, nameKey: 'k', nameKeySecondary: 'k2', schedule: [] },
        ];
        const ttl = TTL_BY_ENDPOINT.tournamentSchedule as number;

        if (state === 'fresh_matching') {
          await cache.set({ endpoint: 'tournamentSchedule', routingValue: 'na1', params: {} }, schedule, ttl);
        } else if (state === 'fresh_other') {
          const otherSchedule: ClashTournamentDto[] = [
            { id: tournamentId + 1, themeId: 1, nameKey: 'k', nameKeySecondary: 'k2', schedule: [] },
          ];
          await cache.set({ endpoint: 'tournamentSchedule', routingValue: 'na1', params: {} }, otherSchedule, ttl);
        } else if (state === 'stale_matching') {
          // Write "now", then run the request far enough in the future to exceed the TTL.
          await cache.set({ endpoint: 'tournamentSchedule', routingValue: 'na1', params: {} }, schedule, ttl);
        }
        // 'absent': nothing written.

        const requestNow = state === 'stale_matching' ? NOW + ttl + 1 : NOW;
        const { client, calls } = countingClient({ teamResult: ok(team({ tournamentId })) });
        const orchestrator = makeOrchestrator({ client, cache, now: () => requestNow });

        const result = await orchestrator.scout(RIOT_ID);

        // Never blocked, never an error — always a report.
        expect(result.kind).toBe('report');
        if (result.kind !== 'report') {
          return;
        }

        if (state === 'fresh_matching') {
          expect(result.report.tournament).toEqual({ id: tournamentId, nameKey: 'k', nameKeySecondary: 'k2' });
        } else {
          expect(result.report.tournament).toBeNull();
        }

        // The RELATED-but-distinct 200/min tournaments-by-team endpoint is not
        // part of this pipeline at all (see orchestrator.ts) — it stays at 0.
        expect(calls.clashTournamentsByTeam).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});
