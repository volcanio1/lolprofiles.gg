import { describe, expect, it, vi } from 'vitest';
import { createInMemoryCacheStore } from '../cache';
import type { MatchDto, RiotApiClient, RiotApiResult } from '../riotApiClient';
import { createRosterEnricher, RECENT_FORM_MATCH_LIMIT, type RosterEnricherOptions } from './enricher';
import type { ClashTeamPlayerDto } from './types';

function makeEnricher(client: RiotApiClient, overrides: Partial<RosterEnricherOptions> = {}) {
  return createRosterEnricher({
    client,
    cache: overrides.cache ?? createInMemoryCacheStore({ now: () => 1_000 }),
    now: overrides.now ?? (() => 1_000),
  });
}

const ok = <T>(data: T): RiotApiResult<T> => ({ kind: 'ok', data });
const notFound = <T>(): RiotApiResult<T> => ({ kind: 'not_found' });
const serverError = <T>(): RiotApiResult<T> => ({ kind: 'server_error', status: 502 });

function matchDto(overrides: {
  matchId: string;
  puuid: string;
  championId: number;
  teamPosition?: string;
  win: boolean;
  participants?: string[];
}): MatchDto {
  const participants = overrides.participants ?? [overrides.puuid, 'other-1', 'other-2'];
  return {
    metadata: { matchId: overrides.matchId, participants },
    info: {
      queueId: 420,
      gameStartTimestamp: 0,
      gameDuration: 1_800,
      participants: [
        {
          puuid: overrides.puuid,
          championName: 'Champ',
          championId: overrides.championId,
          teamPosition: overrides.teamPosition ?? 'MIDDLE',
          win: overrides.win,
          kills: 0,
          deaths: 0,
          assists: 0,
          visionScore: 0,
        },
      ],
    },
  };
}

interface Overrides {
  account?: (puuid: string) => RiotApiResult<{ puuid: string; gameName: string; tagLine: string }>;
  league?: (
    puuid: string,
  ) => RiotApiResult<{ queueType: string; tier: string; rank: string; leaguePoints: number; wins: number; losses: number }[]>;
  masteryTop?: (puuid: string) => RiotApiResult<{ championId: number; championLevel: number; championPoints: number }[]>;
  matchIds?: (puuid: string) => RiotApiResult<string[]>;
  matchById?: (matchId: string) => RiotApiResult<MatchDto>;
}

function fakeClient(overrides: Overrides = {}): RiotApiClient {
  const reject = () => Promise.reject(new Error('not used by the roster enricher'));
  return {
    getAccountByRiotId: reject,
    getRegionByPuuid: reject,
    getSummonerByPuuid: reject,
    getLeagueEntriesByPuuid: (_platform, puuid) =>
      Promise.resolve(
        overrides.league?.(puuid) ??
          ok([{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 40, wins: 12, losses: 8 }]),
      ),
    getMatchIdsByPuuid: (_region, puuid) => Promise.resolve(overrides.matchIds?.(puuid) ?? ok(['NA1_1'])),
    getMatchById: (_region, matchId) =>
      Promise.resolve(
        overrides.matchById?.(matchId) ??
          ok(matchDto({ matchId, puuid: 'a', championId: 62, win: true })),
      ),
    getMatchTimeline: reject,
    getActiveGameByPuuid: reject,
    getAccountByPuuid: (_region, puuid) =>
      Promise.resolve(overrides.account?.(puuid) ?? ok({ puuid, gameName: `Name-${puuid}`, tagLine: 'NA1' })),
    getChampionMastery: reject,
    getClashPlayersByPuuid: reject,
    getClashTeam: reject,
    getClashTournamentsByTeam: reject,
    getChampionMasteryTop: (_platform, puuid) =>
      Promise.resolve(overrides.masteryTop?.(puuid) ?? ok([{ championId: 62, championLevel: 7, championPoints: 50_000 }])),
  } as RiotApiClient;
}

function member(overrides: Partial<ClashTeamPlayerDto> = {}): ClashTeamPlayerDto {
  return { puuid: 'a', position: 'MIDDLE', role: 'MEMBER', ...overrides };
}

describe('createRosterEnricher.enrichAll', () => {
  it('returns exactly one card per member, in roster order', async () => {
    const enricher = makeEnricher(fakeClient());
    const cards = await enricher.enrichAll('na1', 'americas', [
      member({ puuid: 'a' }),
      member({ puuid: 'b' }),
      member({ puuid: 'c' }),
    ]);
    expect(cards.map((card) => card.puuid)).toEqual(['a', 'b', 'c']);
  });

  it('joins Riot ID, ranked entries, champion pool and recent form onto a successful card', async () => {
    const enricher = makeEnricher(fakeClient());
    const [card] = await enricher.enrichAll('na1', 'americas', [member({ puuid: 'a', role: 'CAPTAIN' })]);
    expect(card).toMatchObject({
      puuid: 'a',
      declaredPosition: 'MIDDLE',
      isCaptain: true,
      riotId: { gameName: 'Name-a', tagLine: 'NA1' },
    });
    expect(card.rankedEntries).toEqual([{ tier: 'GOLD', division: 'II', winRatePercent: 60, leaguePoints: 40 }]);
    expect(card.championPool).toEqual([{ championId: 62, masteryPoints: 50_000, masteryLevel: 7 }]);
    expect(card.recentForm).toEqual([
      { matchId: 'NA1_1', championId: 62, role: 'MIDDLE', win: true, participantPuuids: ['a', 'other-1', 'other-2'] },
    ]);
    expect(card.observedRole).toBe('MIDDLE');
  });

  it('marks isCaptain from the member role, not from a separate captain field', async () => {
    const enricher = makeEnricher(fakeClient());
    const [captain, notCaptain] = await enricher.enrichAll('na1', 'americas', [
      member({ puuid: 'a', role: 'CAPTAIN' }),
      member({ puuid: 'b', role: 'MEMBER' }),
    ]);
    expect(captain.isCaptain).toBe(true);
    expect(notCaptain.isCaptain).toBe(false);
  });

  it('degrades only the failed field, never the card (Requirement 2.5)', async () => {
    const enricher = makeEnricher(fakeClient({ account: () => serverError(), masteryTop: () => notFound() }));
    const [card] = await enricher.enrichAll('na1', 'americas', [member({ puuid: 'a' })]);
    expect(card.riotId).toBeNull();
    expect(card.championPool).toBeNull();
    // League and recent form still succeeded.
    expect(card.rankedEntries).toHaveLength(1);
    expect(card.recentForm).toHaveLength(1);
  });

  it('distinguishes an unranked member (empty array) from a failed League call (null) — Requirement 2.7', async () => {
    const unranked = makeEnricher(fakeClient({ league: () => ok([]) }));
    const failed = makeEnricher(fakeClient({ league: () => serverError() }));
    const [u] = await unranked.enrichAll('na1', 'americas', [member()]);
    const [f] = await failed.enrichAll('na1', 'americas', [member()]);
    expect(u.rankedEntries).toEqual([]);
    expect(f.rankedEntries).toBeNull();
  });

  it('excludes an individually-failing match from Recent_Form and continues (Requirement 2.6)', async () => {
    const enricher = makeEnricher(
      fakeClient({
        matchIds: () => ok(['NA1_1', 'NA1_2', 'NA1_3']),
        matchById: (matchId) =>
          matchId === 'NA1_2' ? serverError() : ok(matchDto({ matchId, puuid: 'a', championId: 62, win: true })),
      }),
    );
    const [card] = await enricher.enrichAll('na1', 'americas', [member({ puuid: 'a' })]);
    expect(card.recentForm.map((entry) => entry.matchId)).toEqual(['NA1_1', 'NA1_3']);
  });

  it('never requests more than RECENT_FORM_MATCH_LIMIT match ids (Requirement 2.4)', async () => {
    const getMatchIdsByPuuid = vi.fn(() => Promise.resolve(ok(Array.from({ length: 20 }, (_, i) => `NA1_${i}`))));
    const client = fakeClient();
    client.getMatchIdsByPuuid = getMatchIdsByPuuid as never;

    const enricher = makeEnricher(client);
    const [card] = await enricher.enrichAll('na1', 'americas', [member({ puuid: 'a' })]);

    expect(getMatchIdsByPuuid).toHaveBeenCalledWith('americas', 'a', RECENT_FORM_MATCH_LIMIT);
    expect(card.recentForm.length).toBeLessThanOrEqual(RECENT_FORM_MATCH_LIMIT);
  });

  it('has no Observed_Role when Recent_Form is empty (Requirement 3.6)', async () => {
    const enricher = makeEnricher(fakeClient({ matchIds: () => ok([]) }));
    const [card] = await enricher.enrichAll('na1', 'americas', [member({ puuid: 'a' })]);
    expect(card.recentForm).toEqual([]);
    expect(card.observedRole).toBeNull();
  });

  it('derives Observed_Role as the most frequent recent role, breaking ties toward the most recent match', async () => {
    const enricher = makeEnricher(
      fakeClient({
        matchIds: () => ok(['NA1_1', 'NA1_2', 'NA1_3']),
        matchById: (matchId) => {
          const teamPosition = matchId === 'NA1_1' ? 'TOP' : 'JUNGLE';
          return ok(matchDto({ matchId, puuid: 'a', championId: 62, win: true, teamPosition }));
        },
      }),
    );
    const [card] = await enricher.enrichAll('na1', 'americas', [member({ puuid: 'a' })]);
    expect(card.observedRole).toBe('JUNGLE');
  });

  it('shares matchDetail cache entries across scouting runs (design.md: five-stack cheaper than five strangers)', async () => {
    const cache = createInMemoryCacheStore({ now: () => 1_000 });
    const getMatchById = vi.fn(() => Promise.resolve(ok(matchDto({ matchId: 'NA1_1', puuid: 'shared', championId: 1, win: true }))));
    const client = fakeClient({ matchIds: () => ok(['NA1_1']) });
    client.getMatchById = getMatchById as never;

    const enricher = makeEnricher(client, { cache });
    // Two members who both played the shared match, enriched sequentially so the
    // second run reads a `matchDetail` entry the first run already populated —
    // the same infinite-TTL sharing the main lookup pipeline relies on.
    await enricher.enrichAll('na1', 'americas', [member({ puuid: 'a' })]);
    await enricher.enrichAll('na1', 'americas', [member({ puuid: 'b' })]);

    expect(getMatchById).toHaveBeenCalledTimes(1);
  });
});
