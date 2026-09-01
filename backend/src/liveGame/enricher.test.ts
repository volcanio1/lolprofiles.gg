import { describe, expect, it, vi } from 'vitest';
import { createInMemoryCacheStore } from '../cache';
import type { RiotApiClient, RiotApiResult } from '../riotApiClient';
import { createParticipantEnricher, type ParticipantEnricherOptions } from './enricher';
import type { CurrentGameParticipant } from './types';

function makeEnricher(client: RiotApiClient, overrides: Partial<ParticipantEnricherOptions> = {}) {
  return createParticipantEnricher({
    client,
    cache: overrides.cache ?? createInMemoryCacheStore({ now: () => 1_000 }),
    now: overrides.now ?? (() => 1_000),
  });
}

const ok = <T>(data: T): RiotApiResult<T> => ({ kind: 'ok', data });
const notFound = <T>(): RiotApiResult<T> => ({ kind: 'not_found' });
const serverError = <T>(): RiotApiResult<T> => ({ kind: 'server_error', status: 502 });

interface Overrides {
  account?: (puuid: string) => RiotApiResult<{ puuid: string; gameName: string; tagLine: string }>;
  league?: (puuid: string) => RiotApiResult<{ queueType: string; tier: string; rank: string; leaguePoints: number; wins: number; losses: number }[]>;
  mastery?: (puuid: string, championId: number) => RiotApiResult<{ championId: number; championLevel: number; championPoints: number }>;
}

function fakeClient(overrides: Overrides = {}): RiotApiClient {
  const reject = () => Promise.reject(new Error('not used by the enricher'));
  return {
    getAccountByRiotId: reject,
    getRegionByPuuid: reject,
    getSummonerByPuuid: reject,
    getLeagueEntriesByPuuid: (_platform, puuid) =>
      Promise.resolve(overrides.league?.(puuid) ?? ok([{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 40, wins: 12, losses: 8 }])),
    getMatchIdsByPuuid: reject,
    getMatchById: reject,
    getMatchTimeline: reject,
    getActiveGameByPuuid: reject,
    getAccountByPuuid: (_region, puuid) =>
      Promise.resolve(overrides.account?.(puuid) ?? ok({ puuid, gameName: `Name-${puuid}`, tagLine: 'NA1' })),
    getChampionMastery: (_platform, puuid, championId) =>
      Promise.resolve(overrides.mastery?.(puuid, championId) ?? ok({ championId, championLevel: 7, championPoints: 50_000 })),
    getClashPlayersByPuuid: reject,
    getClashTeam: reject,
    getClashTournamentsByTeam: reject,
    getChampionMasteryTop: reject,
  } as RiotApiClient;
}

function participant(overrides: Partial<CurrentGameParticipant> = {}): CurrentGameParticipant {
  return {
    puuid: 'p1',
    teamId: 100,
    championId: 62,
    spell1Id: 4,
    spell2Id: 7,
    bot: false,
    perks: { perkIds: [8005, 9111], perkStyle: 8000, perkSubStyle: 8100 },
    ...overrides,
  };
}

describe('createParticipantEnricher.enrichAll', () => {
  it('returns exactly one card per participant, in input order', async () => {
    const enricher = makeEnricher(fakeClient());
    const cards = await enricher.enrichAll('na1', 'americas', [
      participant({ puuid: 'a' }),
      participant({ puuid: 'b' }),
      participant({ puuid: 'c' }),
    ]);
    expect(cards.map((card) => card.puuid)).toEqual(['a', 'b', 'c']);
  });

  it('joins Riot ID, ranked entries and mastery onto a successful card', async () => {
    const enricher = makeEnricher(fakeClient());
    const [card] = await enricher.enrichAll('na1', 'americas', [participant({ puuid: 'a', championId: 62 })]);
    expect(card).toMatchObject({
      puuid: 'a',
      championId: 62,
      perkIds: [8005, 9111],
      isBot: false,
      riotId: { gameName: 'Name-a', tagLine: 'NA1' },
      championMasteryPoints: 50_000,
      championMasteryLevel: 7,
    });
    expect(card.rankedEntries).toEqual([
      { queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', division: 'II', leaguePoints: 40, wins: 12, losses: 8 },
    ]);
  });

  it('issues no enrichment call for a bot and returns an all-absent card', async () => {
    const account = vi.fn();
    const league = vi.fn();
    const mastery = vi.fn();
    const client = fakeClient();
    client.getAccountByPuuid = account as never;
    client.getLeagueEntriesByPuuid = league as never;
    client.getChampionMastery = mastery as never;

    const enricher = makeEnricher(client);
    const [card] = await enricher.enrichAll('na1', 'americas', [participant({ puuid: 'bot', bot: true })]);

    expect(account).not.toHaveBeenCalled();
    expect(league).not.toHaveBeenCalled();
    expect(mastery).not.toHaveBeenCalled();
    expect(card).toMatchObject({ isBot: true, riotId: null, rankedEntries: null, championMasteryPoints: null });
  });

  it('degrades only the failed field, never the card', async () => {
    const enricher = makeEnricher(fakeClient({ account: () => serverError(), mastery: () => notFound() }));
    const [card] = await enricher.enrichAll('na1', 'americas', [participant({ puuid: 'a' })]);
    expect(card.riotId).toBeNull();
    expect(card.championMasteryPoints).toBeNull();
    expect(card.championMasteryLevel).toBeNull();
    // League still succeeded.
    expect(card.rankedEntries).toHaveLength(1);
  });

  it('distinguishes an unranked player (empty array) from a failed League call (null)', async () => {
    const unranked = makeEnricher(fakeClient({ league: () => ok([]) }));
    const failed = makeEnricher(fakeClient({ league: () => serverError() }));
    const [u] = await unranked.enrichAll('na1', 'americas', [participant()]);
    const [f] = await failed.enrichAll('na1', 'americas', [participant()]);
    expect(u.rankedEntries).toEqual([]);
    expect(f.rankedEntries).toBeNull();
  });

  it('caches enrichment so a second lobby assembly issues no fresh calls (Requirement 6.3)', async () => {
    const account = vi.fn((_r: unknown, puuid: string) => Promise.resolve(ok({ puuid, gameName: 'N', tagLine: 'NA1' })));
    const league = vi.fn(() => Promise.resolve(ok([])));
    const mastery = vi.fn((_p: unknown, _puuid: string, championId: number) =>
      Promise.resolve(ok({ championId, championLevel: 5, championPoints: 100 })),
    );
    const client = fakeClient();
    client.getAccountByPuuid = account as never;
    client.getLeagueEntriesByPuuid = league as never;
    client.getChampionMastery = mastery as never;

    const cache = createInMemoryCacheStore({ now: () => 1_000 });
    const enricher = createParticipantEnricher({ client, cache, now: () => 1_000 });

    await enricher.enrichAll('na1', 'americas', [participant({ puuid: 'a' })]);
    await enricher.enrichAll('na1', 'americas', [participant({ puuid: 'a' })]);

    expect(account).toHaveBeenCalledTimes(1);
    expect(league).toHaveBeenCalledTimes(1);
    expect(mastery).toHaveBeenCalledTimes(1);
  });

  it('normalises a missing puuid to "" and issues no enrichment call for that participant', async () => {
    const account = vi.fn();
    const client = fakeClient();
    client.getAccountByPuuid = account as never;
    const enricher = makeEnricher(client);
    // Riot sometimes returns a participant with no puuid.
    const [card] = await enricher.enrichAll('na1', 'americas', [participant({ puuid: null as unknown as string })]);
    expect(card.puuid).toBe('');
    expect(card.riotId).toBeNull();
    expect(account).not.toHaveBeenCalled();
  });

  it('never rejects even when every enrichment call fails for every participant', async () => {
    const enricher = makeEnricher(
      fakeClient({ account: () => serverError(), league: () => serverError(), mastery: () => serverError() }),
    );
    const cards = await enricher.enrichAll('na1', 'americas', [participant({ puuid: 'a' }), participant({ puuid: 'b' })]);
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card).toMatchObject({ riotId: null, rankedEntries: null, championMasteryPoints: null });
    }
  });
});
