import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from './app';
import { createInMemoryCacheStore, type InMemoryCacheStore } from './cache';
import { createLookupOrchestrator } from './orchestrator';
import { createRateLimitManager } from './rateLimit';
import {
  createRiotApiClient,
  type RiotHttpResponse,
  type RiotHttpTransport,
} from './riotApiClient';

/**
 * Task 18.2 — end-to-end tests over the REAL assembled stack.
 *
 * Everything from `createApp` down is production code: the API router, the
 * orchestrator, the Insight Engine, the cache store, the rate limit manager and the
 * Riot API client. The ONLY substitution is the HTTP transport at the very bottom,
 * which serves canned Riot payloads instead of reaching the network — so these
 * tests exercise every layer's real wiring, including URL construction, the
 * `X-Riot-Token` header, cache key derivation, TTLs and queue filtering.
 *
 * The clock is a fake counter and the timeout scheduler never fires, so no test
 * waits on real time. The API key is a fixed fake string, which lets the key-leakage
 * assertions be genuine rather than vacuous.
 */

const API_KEY = 'RGAPI-e2e-fake-key-do-not-use';
const PUUID = 'e2e-puuid-0000000000000000000000000000000000000000000000000000000000';
const GAME_NAME = 'Doffy';
const TAG_LINE = 'Smile';

/** Riot payloads, shaped as the real API returns them. */
function accountBody() {
  return { puuid: PUUID, gameName: GAME_NAME, tagLine: TAG_LINE };
}

function summonerBody() {
  return { puuid: PUUID, id: 'summ-e2e', summonerLevel: 496, profileIconId: 7 };
}

function leagueBody() {
  return [
    { queueType: 'RANKED_SOLO_5x5', tier: 'PLATINUM', rank: 'IV', leaguePoints: 51, wins: 60, losses: 60 },
    // A queue type no hardcoded list would have predicted; a real lookup returned it.
    { queueType: 'RANKED_PREMADE_5x5', tier: 'SILVER', rank: 'II', leaguePoints: 12, wins: 0, losses: 0 },
  ];
}

const MATCH_IDS = ['EUW1_1', 'EUW1_2', 'EUW1_3', 'EUW1_4', 'EUW1_5', 'EUW1_6'];

/** Six matches: five Summoner's Rift (included) and one ARAM (excluded by 3.5). */
function matchBody(matchId: string) {
  const index = MATCH_IDS.indexOf(matchId);
  const isAram = matchId === 'EUW1_6';
  return {
    metadata: { matchId, participants: [PUUID, 'other-player'] },
    info: {
      queueId: isAram ? 450 : 420,
      gameStartTimestamp: 1_700_000_000_000 + index * 3_600_000,
      gameDuration: 1_800,
      participants: [
        {
          puuid: PUUID,
          summonerName: 'DoffyName',
          championName: index < 3 ? 'Vayne' : 'Caitlyn',
          teamPosition: 'BOTTOM',
          win: index % 2 === 0,
          kills: 6,
          deaths: 3,
          assists: 9,
          visionScore: 20,
        },
        {
          puuid: 'other-player',
          summonerName: 'OtherName',
          championName: 'Garen',
          teamPosition: 'TOP',
          win: index % 2 !== 0,
          kills: 2,
          deaths: 7,
          assists: 3,
          visionScore: 9,
        },
      ],
    },
  };
}

function headers(values: Record<string, string> = {}) {
  const lower = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    get(name: string): string | null {
      return lower.get(name.toLowerCase()) ?? null;
    },
  };
}

function json(status: number, body: unknown): RiotHttpResponse {
  return { status, headers: headers(), json: () => Promise.resolve(body) };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  cache: InMemoryCacheStore;
  requests: { url: string; token: string | undefined }[];
  setAccountStatus: (status: number) => void;
  setSummonerStatus: (status: number) => void;
}

/** Assembles the real graph over a canned transport. */
function makeHarness(): Harness {
  const requests: { url: string; token: string | undefined }[] = [];
  let accountStatus = 200;
  let summonerStatus = 200;
  const now = () => 1_700_000_100_000;

  const transport: RiotHttpTransport = (url, init) => {
    requests.push({ url, token: init.headers['X-Riot-Token'] });

    if (url.includes('/riot/account/v1/accounts/by-riot-id/')) {
      return Promise.resolve(accountStatus === 200 ? json(200, accountBody()) : json(accountStatus, {}));
    }
    if (url.includes('/lol/summoner/v4/summoners/by-puuid/')) {
      return Promise.resolve(summonerStatus === 200 ? json(200, summonerBody()) : json(summonerStatus, {}));
    }
    if (url.includes('/lol/league/v4/entries/by-puuid/')) {
      return Promise.resolve(json(200, leagueBody()));
    }
    if (url.includes('/lol/match/v5/matches/by-puuid/')) {
      return Promise.resolve(json(200, MATCH_IDS));
    }
    const matchId = /\/lol\/match\/v5\/matches\/([^/?]+)$/.exec(url)?.[1];
    if (matchId !== undefined) {
      return Promise.resolve(json(200, matchBody(matchId)));
    }
    return Promise.resolve(json(404, {}));
  };

  const cache = createInMemoryCacheStore({ now });
  const rateLimitManager = createRateLimitManager({ now, sleep: () => Promise.resolve() });
  const riotApiClient = createRiotApiClient({
    fetch: transport,
    apiKey: API_KEY,
    rateLimitManager,
    now,
    // Never fires: no test depends on a timeout here.
    scheduleTimeout: () => () => undefined,
    sleep: () => Promise.resolve(),
  });
  const orchestrator = createLookupOrchestrator({
    cache,
    riotApiClient,
    now,
    scheduleTimeout: () => () => undefined,
    logger: { authFailure: () => undefined },
  });
  const app = createApp({
    orchestrator,
    cache,
    now,
    logger: { unexpectedError: () => undefined },
  });

  return {
    app,
    cache,
    requests,
    setAccountStatus: (status) => {
      accountStatus = status;
    },
    setSummonerStatus: (status) => {
      summonerStatus = status;
    },
  };
}

describe('end-to-end: successful lookup through the assembled stack', () => {
  it('returns a complete Profile_Report', async () => {
    const harness = makeHarness();

    const response = await request(harness.app)
      .post('/api/lookup')
      .send({ riotId: `${GAME_NAME}#${TAG_LINE}`, region: 'europe' });

    expect(response.status).toBe(200);
    const report = response.body;

    expect(report.riotId).toEqual({ gameName: GAME_NAME, tagLine: TAG_LINE });
    expect(report.summonerLevel).toBe(496);
    expect(report.profileIconId).toBe(7);
    // Requirement 6.1/6.2: both queues, including the unanticipated one.
    expect(report.stats.rankedByQueue.RANKED_SOLO_5x5).toEqual({
      tier: 'PLATINUM',
      division: 'IV',
      winRatePercent: 50,
    });
    // Requirement 6.6: 0 wins + 0 losses renders as N/A, not 0%.
    expect(report.stats.rankedByQueue.RANKED_PREMADE_5x5.winRatePercent).toBe('N/A');
    // Requirement 3.5: the ARAM match is excluded, leaving five.
    expect(report.stats.topChampions.reduce((total: number, c: { gamesPlayed: number }) => total + c.gamesPlayed, 0)).toBe(5);
    expect(report.stats.mostPlayedRole).toBe('BOTTOM');
    // Requirement 7.3.
    expect(report.averageMatchDurationMinutes).toBe(30);
    // Requirement 7.4: five included matches clears the limited-data threshold.
    expect(report.limitedDataNotice).toBe(false);
    expect(report.funFacts).toHaveLength(4);
    expect(report.partialDataWarning).toBe(false);
    // Requirement 11.5: nothing was cached before, so this is a first retrieval.
    expect(report.lastUpdated).toBeNull();
  });

  it('calls every Riot endpoint with the right routing value and the key header', async () => {
    const harness = makeHarness();

    await request(harness.app)
      .post('/api/lookup')
      .send({ riotId: `${GAME_NAME}#${TAG_LINE}`, region: 'europe' });

    const urls = harness.requests.map((entry) => entry.url);
    // Requirement 2.1: regional routing for Account-V1.
    expect(urls.some((url) => url.startsWith('https://europe.api.riotgames.com/riot/account/v1/'))).toBe(true);
    // Requirements 2.2/2.3: platform routing, defaulted to europe's first platform.
    expect(urls.some((url) => url.startsWith('https://euw1.api.riotgames.com/lol/summoner/v4/'))).toBe(true);
    expect(urls.some((url) => url.startsWith('https://euw1.api.riotgames.com/lol/league/v4/'))).toBe(true);
    // Requirements 3.1/3.2: regional routing for Match-V5, bounded at 100.
    expect(urls.some((url) => url.includes('/lol/match/v5/matches/by-puuid/') && url.includes('count=100'))).toBe(true);
    expect(urls.filter((url) => /\/lol\/match\/v5\/matches\/EUW1_\d$/.test(url))).toHaveLength(6);
    // Requirement 4.1: every single request carries the key.
    expect(harness.requests.every((entry) => entry.token === API_KEY)).toBe(true);
  });

  it('never returns the API key to the client (Requirement 4.2)', async () => {
    const harness = makeHarness();

    const response = await request(harness.app)
      .post('/api/lookup')
      .send({ riotId: `${GAME_NAME}#${TAG_LINE}`, region: 'europe' });

    const serialized = JSON.stringify(response.body) + JSON.stringify(response.headers);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain('RGAPI');
  });

  it('serves a repeat lookup from cache without calling Riot again (Requirement 10.5)', async () => {
    const harness = makeHarness();
    const body = { riotId: `${GAME_NAME}#${TAG_LINE}`, region: 'europe' };

    await request(harness.app).post('/api/lookup').send(body);
    const callsAfterFirst = harness.requests.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await request(harness.app).post('/api/lookup').send(body);

    expect(second.status).toBe(200);
    expect(harness.requests).toHaveLength(callsAfterFirst);
    // Requirement 11.4: the data now has a retrieval timestamp.
    expect(second.body.lastUpdated).not.toBeNull();
  });
});

describe('end-to-end: error paths through the assembled stack', () => {
  it('reports a missing account as 404 PLAYER_NOT_FOUND and issues no downstream call', async () => {
    const harness = makeHarness();
    harness.setAccountStatus(404);

    const response = await request(harness.app)
      .post('/api/lookup')
      .send({ riotId: `${GAME_NAME}#${TAG_LINE}`, region: 'europe' });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('PLAYER_NOT_FOUND');
    expect(response.body.error.message).toContain(`${GAME_NAME}#${TAG_LINE}`);
    // Requirement 2.4: nothing beyond Account-V1 was attempted.
    expect(harness.requests).toHaveLength(1);
    expect(harness.cache.size).toBe(0);
  });

  it('reports the wrong-region case distinctly (Requirement 9.10)', async () => {
    const harness = makeHarness();
    // The account resolves globally, but there is no summoner on this platform —
    // exactly what a live lookup on the wrong region produced.
    harness.setSummonerStatus(404);

    const response = await request(harness.app)
      .post('/api/lookup')
      .send({ riotId: `${GAME_NAME}#${TAG_LINE}`, region: 'americas' });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('PLAYER_NOT_ON_PLATFORM');
    expect(response.body.error.region).toBe('americas');
    expect(response.body.error.platform).toBe('na1');
    expect(response.body.error.message).not.toMatch(/unavailable/i);
  });

  it('rejects a malformed Riot ID before any Riot call (Requirement 9.1)', async () => {
    const harness = makeHarness();

    const response = await request(harness.app).post('/api/lookup').send({ riotId: 'NoHash', region: 'europe' });

    expect(response.status).toBe(400);
    expect(response.body.error.validationRule).toBe('MISSING_HASH');
    expect(harness.requests).toHaveLength(0);
  });
});

describe('end-to-end: deletion flow (Requirements 12.5, 12.6)', () => {
  it('populates the cache, deletes it, and leaves the PUUID nowhere', async () => {
    const harness = makeHarness();
    const body = { riotId: `${GAME_NAME}#${TAG_LINE}`, region: 'europe' };

    await request(harness.app).post('/api/lookup').send(body);
    expect(harness.cache.size).toBeGreaterThan(0);
    expect(JSON.stringify(harness.cache.dumpForVerification())).toContain(PUUID);

    const deletion = await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    expect(deletion.status).toBe(200);
    expect(deletion.body.found).toBe(true);
    expect(typeof deletion.body.deletedAt).toBe('string');
    // Exhaustive: keys, values, nested participant records.
    expect(JSON.stringify(harness.cache.dumpForVerification())).not.toContain(PUUID);
  });

  it('is idempotent and answers found: false on a repeat (Requirement 12.6)', async () => {
    const harness = makeHarness();
    await request(harness.app).post('/api/lookup').send({ riotId: `${GAME_NAME}#${TAG_LINE}`, region: 'europe' });

    await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });
    const second = await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    expect(second.status).toBe(200);
    expect(second.body.found).toBe(false);
  });

  it('leaves the report COMPLETE on the next lookup after a deletion', async () => {
    /**
     * This is the regression test for the defect live testing exposed. With match
     * details retained-and-redacted, the next lookup returned a report with the
     * right summoner level and ZERO champions, because every cached match had lost
     * the subject's participant row and indefinitely-cached entries are never
     * re-fetched. Eviction makes the next lookup re-fetch them.
     */
    const harness = makeHarness();
    const body = { riotId: `${GAME_NAME}#${TAG_LINE}`, region: 'europe' };

    const before = await request(harness.app).post('/api/lookup').send(body);
    const championsBefore = before.body.stats.topChampions.length;
    expect(championsBefore).toBeGreaterThan(0);

    await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    const after = await request(harness.app).post('/api/lookup').send(body);

    expect(after.status).toBe(200);
    expect(after.body.stats.topChampions).toHaveLength(championsBefore);
    expect(after.body.funFacts).toHaveLength(before.body.funFacts.length);
    expect(after.body.limitedDataNotice).toBe(false);
    // Everything was re-fetched, so it is a first retrieval again.
    expect(after.body.lastUpdated).toBeNull();
  });

  it('does not evict a co-participant\u2019s own cached entries', async () => {
    const harness = makeHarness();
    await request(harness.app).post('/api/lookup').send({ riotId: `${GAME_NAME}#${TAG_LINE}`, region: 'europe' });
    // A bystander's summoner entry, unrelated to the subject.
    await harness.cache.set(
      { endpoint: 'summoner', routingValue: 'euw1', params: { puuid: 'other-player' } },
      { puuid: 'other-player', summonerLevel: 88 },
      60 * 60 * 1000,
    );

    await request(harness.app).post('/api/privacy/delete').send({ puuid: PUUID });

    const bystander = await harness.cache.get({
      endpoint: 'summoner',
      routingValue: 'euw1',
      params: { puuid: 'other-player' },
    });
    expect(bystander).toBeDefined();
  });
});
