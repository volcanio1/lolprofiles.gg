/**
 * Property test for the Roster Enricher (clash-scouting task 4.2).
 *
 * For any team and any assignment of outcomes — drawn from the full
 * `RiotApiResult` variant set — to each enrichment call for each member, the
 * enricher must produce exactly one `RosterCard` per member, in roster order,
 * with each field degraded independently: `riotId`/`rankedEntries`/
 * `championPool` are non-null if and only if their call succeeded, and
 * `recentForm` contains exactly the matches whose individual retrieval
 * succeeded, bounded at `RECENT_FORM_MATCH_LIMIT`.
 *
 * Match-id outcomes are drawn from a small shared universe (`MATCH_ID_SPACE`)
 * rather than each member inventing unrelated ids, so members' Recent_Form
 * windows genuinely overlap — exercising the same shared `matchDetail` cache
 * entry the real enricher relies on (design.md: "a five-stack is cheaper to
 * scout than five strangers"). Each match's `MatchDto` is built ONCE per id
 * with a participant row for every roster member, matching how a real
 * Match-V5 response serves all ten players from one shared document — a
 * per-requester-only `MatchDto` would let one member's successful retrieval
 * silently exclude another member who legitimately played in the same game.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createInMemoryCacheStore } from '../cache';
import type { MatchDto, RiotApiClient, RiotApiResult } from '../riotApiClient';
import { createRosterEnricher, RECENT_FORM_MATCH_LIMIT } from './enricher';
import type { ClashTeamPlayerDto } from './types';

const PUUIDS = ['a', 'b', 'c'] as const;
const MATCH_ID_SPACE = Array.from({ length: 14 }, (_, i) => `m${String(i)}`);

/** Every `RiotApiResult` variant, `ok` parametrized by the caller's data arbitrary. */
function outcomeArb<T>(dataArb: fc.Arbitrary<T>): fc.Arbitrary<RiotApiResult<T>> {
  return fc.oneof(
    dataArb.map((data): RiotApiResult<T> => ({ kind: 'ok', data })),
    fc.constant<RiotApiResult<T>>({ kind: 'not_found' }),
    fc.constant<RiotApiResult<T>>({ kind: 'rate_limited' }),
    fc.constant<RiotApiResult<T>>({ kind: 'server_error', status: 502 }),
    fc.constant<RiotApiResult<T>>({ kind: 'auth_error', status: 401 }),
    fc.constant<RiotApiResult<T>>({ kind: 'timeout' }),
    fc.constant<RiotApiResult<T>>({ kind: 'network_error' }),
  );
}

/** One shared MatchDto per successful match id, with a row for every roster member — realistic sharing. */
function sharedMatchDto(matchId: string): MatchDto {
  return {
    metadata: { matchId, participants: [...PUUIDS] },
    info: {
      queueId: 700,
      gameStartTimestamp: 0,
      gameDuration: 1_800,
      participants: PUUIDS.map((puuid) => ({
        puuid,
        championName: 'Champ',
        championId: 1,
        teamPosition: 'MIDDLE',
        win: true,
        kills: 0,
        deaths: 0,
        assists: 0,
        visionScore: 0,
      })),
    },
  };
}

/** One outcome per id in `MATCH_ID_SPACE`, shared by every member who happens to reference it. */
const matchUniverseArb = fc.tuple(
  ...MATCH_ID_SPACE.map((matchId) => outcomeArb(fc.constant(matchId)).map((outcome) => ({ matchId, outcome }))),
).map((entries) => new Map(entries.map(({ matchId, outcome }) => [matchId, outcome])));

interface MemberPlan {
  puuid: string;
  member: ClashTeamPlayerDto;
  account: RiotApiResult<{ puuid: string; gameName: string; tagLine: string }>;
  league: RiotApiResult<{ queueType: string; tier: string; rank: string; leaguePoints: number; wins: number; losses: number }[]>;
  masteryTop: RiotApiResult<{ championId: number; championLevel: number; championPoints: number }[]>;
  matchIds: RiotApiResult<string[]>;
}

function memberPlanArb(puuid: string): fc.Arbitrary<MemberPlan> {
  return fc
    .record({
      account: outcomeArb(fc.constant({ puuid, gameName: `Name-${puuid}`, tagLine: 'NA1' })),
      league: outcomeArb(fc.constant([{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 40, wins: 5, losses: 5 }])),
      masteryTop: outcomeArb(fc.constant([{ championId: 1, championLevel: 7, championPoints: 50_000 }])),
      matchIds: outcomeArb(fc.uniqueArray(fc.constantFrom(...MATCH_ID_SPACE), { maxLength: MATCH_ID_SPACE.length })),
    })
    .map(({ account, league, masteryTop, matchIds }) => ({
      puuid,
      member: { puuid, position: 'MIDDLE', role: 'MEMBER' } as ClashTeamPlayerDto,
      account,
      league,
      masteryTop,
      matchIds,
    }));
}

const teamArb = fc.tuple(matchUniverseArb, ...PUUIDS.map(memberPlanArb));

function fakeClient(plans: readonly MemberPlan[], matchOutcomes: ReadonlyMap<string, RiotApiResult<string>>): RiotApiClient {
  const byPuuid = new Map(plans.map((p) => [p.puuid, p]));
  const reject = () => Promise.reject(new Error('not used by the roster enricher'));
  return {
    getAccountByRiotId: reject,
    getRegionByPuuid: reject,
    getSummonerByPuuid: reject,
    getLeagueEntriesByPuuid: (_platform, puuid) => Promise.resolve(byPuuid.get(puuid)!.league),
    getMatchIdsByPuuid: (_region, puuid) => Promise.resolve(byPuuid.get(puuid)!.matchIds),
    getMatchById: (_region, matchId) => {
      const outcome = matchOutcomes.get(matchId);
      if (outcome === undefined) {
        return Promise.resolve({ kind: 'not_found' });
      }
      return Promise.resolve(outcome.kind === 'ok' ? { kind: 'ok', data: sharedMatchDto(matchId) } : outcome);
    },
    getMatchTimeline: reject,
    getActiveGameByPuuid: reject,
    getAccountByPuuid: (_region, puuid) => Promise.resolve(byPuuid.get(puuid)!.account),
    getChampionMastery: reject,
    getClashPlayersByPuuid: reject,
    getClashTeam: reject,
    getClashTournamentsByTeam: reject,
    getChampionMasteryTop: (_platform, puuid) => Promise.resolve(byPuuid.get(puuid)!.masteryTop),
  } as RiotApiClient;
}

describe('createRosterEnricher.enrichAll — Property 3: enrichment failure degrades a field, never a member or a report', () => {
  // Feature: clash-scouting, Property 3: Roster enrichment failure degrades a field, never a member or a report
  // **Validates: Requirements 2.4, 2.5, 2.6, 2.7**
  it('produces one card per member in roster order with each field independently null iff its call failed', async () => {
    await fc.assert(
      fc.asyncProperty(teamArb, async ([matchOutcomes, ...plans]) => {
        const cache = createInMemoryCacheStore({ now: () => 1_000 });
        const enricher = createRosterEnricher({ client: fakeClient(plans, matchOutcomes), cache, now: () => 1_000 });
        const members = plans.map((p) => p.member);

        const cards = await enricher.enrichAll('na1', 'americas', members);

        // Exactly one card per member, in roster order.
        expect(cards.map((c) => c.puuid)).toEqual(plans.map((p) => p.puuid));

        for (const [i, plan] of plans.entries()) {
          const card = cards[i];

          expect(card.riotId !== null).toBe(plan.account.kind === 'ok');
          expect(card.rankedEntries !== null).toBe(plan.league.kind === 'ok');
          expect(card.championPool !== null).toBe(plan.masteryTop.kind === 'ok');

          if (plan.matchIds.kind !== 'ok') {
            expect(card.recentForm).toEqual([]);
          } else {
            const expectedIds = plan.matchIds.data
              .slice(0, RECENT_FORM_MATCH_LIMIT)
              .filter((matchId) => matchOutcomes.get(matchId)?.kind === 'ok');
            expect(card.recentForm.map((entry) => entry.matchId)).toEqual(expectedIds);
          }
          expect(card.recentForm.length).toBeLessThanOrEqual(RECENT_FORM_MATCH_LIMIT);
        }
      }),
      { numRuns: 100 },
    );
  });
});
