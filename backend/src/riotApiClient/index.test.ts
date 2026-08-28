import { describe, it, expect } from 'vitest';
import { RateLimitExceededError, type RateLimitHeaders, type RateLimitManager } from '../rateLimit';
import {
  API_KEY_HEADER,
  DEFAULT_RETRY_AFTER_SECONDS,
  MAX_RETRY_ATTEMPTS,
  REQUEST_TIMEOUT_MS,
  RIOT_METHODS,
  createRiotApiClient,
  parseRetryAfterSeconds,
  type RiotHttpRequestInit,
  type RiotHttpResponse,
  type RiotHttpTransport,
} from './index';

/**
 * Integration tests for endpoint wiring (task 7.5) against a fake transport.
 * Nothing here touches the network, and the timeout scheduler is injected and
 * never fires unless a test asks it to, so no real timer is ever awaited.
 */

const API_KEY = 'RGAPI-test-key-0000';

interface RecordedCall {
  url: string;
  init: RiotHttpRequestInit;
}

interface RecordedReservation {
  routingValue: string;
  method: string;
}

interface RecordedHeaderReport {
  routingValue: string;
  method: string;
  headers: RateLimitHeaders;
}

/** Minimal case-insensitive header double, matching the `HeaderGetter` shape. */
function headers(values: Record<string, string> = {}): RateLimitHeaders {
  const lower = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    get(name: string): string | null {
      return lower.get(name.toLowerCase()) ?? null;
    },
  };
}

function jsonResponse(status: number, body: unknown, responseHeaders: RateLimitHeaders = headers()): RiotHttpResponse {
  return {
    status,
    headers: responseHeaders,
    json: () => Promise.resolve(body),
  };
}

interface Harness {
  client: ReturnType<typeof createRiotApiClient>;
  calls: RecordedCall[];
  reservations: RecordedReservation[];
  headerReports: RecordedHeaderReport[];
  sleeps: number[];
  fireTimeout: () => void;
}

interface HarnessOptions {
  /** Responses served in order; the last one repeats once exhausted. */
  responses?: RiotHttpResponse[];
  /** When set, the transport rejects with this reason instead of responding. */
  rejectWith?: unknown;
  /** When true, the injected timeout fires before the transport resolves. */
  timeoutImmediately?: boolean;
  /** When set, `reserveSlot` throws this. */
  reserveSlotThrows?: unknown;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const calls: RecordedCall[] = [];
  const reservations: RecordedReservation[] = [];
  const headerReports: RecordedHeaderReport[] = [];
  const sleeps: number[] = [];
  const responses = options.responses ?? [jsonResponse(200, { ok: true })];
  let index = 0;
  let fire: () => void = () => {
    /* no timeout armed */
  };

  const transport: RiotHttpTransport = (url, init) => {
    calls.push({ url, init });
    if (options.timeoutImmediately === true) {
      fire();
    }
    if ('rejectWith' in options) {
      return Promise.reject(options.rejectWith);
    }
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(response);
  };

  const rateLimitManager: RateLimitManager = {
    reserveSlot: (routingValue, method) => {
      reservations.push({ routingValue, method });
      if ('reserveSlotThrows' in options) {
        return Promise.reject(options.reserveSlotThrows);
      }
      return Promise.resolve();
    },
    recordResponseHeaders: (routingValue, method, responseHeaders) => {
      headerReports.push({ routingValue, method, headers: responseHeaders });
    },
  };

  const client = createRiotApiClient({
    fetch: transport,
    apiKey: API_KEY,
    rateLimitManager,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    now: () => 0,
    scheduleTimeout: (_ms, onElapsed) => {
      fire = onElapsed;
      return () => {
        fire = () => {
          /* cancelled */
        };
      };
    },
  });

  return {
    client,
    calls,
    reservations,
    headerReports,
    sleeps,
    fireTimeout: () => {
      fire();
    },
  };
}

describe('URL construction and routing values', () => {
  it('builds the Account-V1 URL on the regional routing value, URL-encoding both Riot ID parts', async () => {
    const harness = makeHarness();

    await harness.client.getAccountByRiotId('europe', 'Løng Name', 'EU W');

    expect(harness.calls[0].url).toBe(
      'https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/L%C3%B8ng%20Name/EU%20W',
    );
  });

  it('builds the Account-V1 region-by-game-by-puuid URL on the (non-routing) regional value', async () => {
    const harness = makeHarness();

    await harness.client.getRegionByPuuid('europe', 'lol', 'puuid/with slash');

    expect(harness.calls[0].url).toBe(
      'https://europe.api.riotgames.com/riot/account/v1/region/by-game/lol/by-puuid/puuid%2Fwith%20slash',
    );
  });

  it('builds the Summoner-V4 URL on the platform routing value', async () => {
    const harness = makeHarness();

    await harness.client.getSummonerByPuuid('na1', 'puuid-1');

    expect(harness.calls[0].url).toBe(
      'https://na1.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/puuid-1',
    );
  });

  it('builds the League-V4 by-puuid URL on the platform routing value', async () => {
    const harness = makeHarness({ responses: [jsonResponse(200, [])] });

    await harness.client.getLeagueEntriesByPuuid('kr', 'puuid-1');

    expect(harness.calls[0].url).toBe('https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/puuid-1');
  });

  it('builds the Match-V5 match-ids URL on the regional routing value with the count query parameter', async () => {
    const harness = makeHarness({ responses: [jsonResponse(200, [])] });

    await harness.client.getMatchIdsByPuuid('sea', 'puuid/with slash', 100);

    expect(harness.calls[0].url).toBe(
      'https://sea.api.riotgames.com/lol/match/v5/matches/by-puuid/puuid%2Fwith%20slash/ids?count=100',
    );
  });

  it('builds the Match-V5 match-by-id URL on the regional routing value', async () => {
    const harness = makeHarness();

    await harness.client.getMatchById('americas', 'NA1_123');

    expect(harness.calls[0].url).toBe('https://americas.api.riotgames.com/lol/match/v5/matches/NA1_123');
  });

  it('builds the Spectator-V5 active-games URL on the platform routing value (live-game 1.1)', async () => {
    const harness = makeHarness();

    await harness.client.getActiveGameByPuuid('euw1', 'puuid/with slash');

    expect(harness.calls[0].url).toBe(
      'https://euw1.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/puuid%2Fwith%20slash',
    );
  });

  it('builds the Account-V1 by-puuid URL on the regional routing value (live-game 2.1)', async () => {
    const harness = makeHarness();

    await harness.client.getAccountByPuuid('asia', 'puuid-1');

    expect(harness.calls[0].url).toBe('https://asia.api.riotgames.com/riot/account/v1/accounts/by-puuid/puuid-1');
  });

  it('builds the Champion-Mastery-V4 by-champion URL on the platform routing value (live-game 2.3)', async () => {
    const harness = makeHarness();

    await harness.client.getChampionMastery('na1', 'puuid-1', 62);

    expect(harness.calls[0].url).toBe(
      'https://na1.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/puuid-1/by-champion/62',
    );
  });

  it('projects a 200 match body to the MatchDto shape, dropping undeclared fields (specs/match-cache/ Requirement 2.2)', async () => {
    const rawBody = {
      metadata: { dataVersion: '2', matchId: 'NA1_9', participants: ['p1'] },
      info: {
        queueId: 420,
        gameStartTimestamp: 1_726_000_000_000,
        gameDuration: 1800,
        mapId: 11,
        teams: [{ teamId: 100, win: true }],
        participants: [
          { puuid: 'p1', championName: 'Ahri', win: true, kills: 5, deaths: 2, assists: 7, visionScore: 20, challenges: { kda: 6 }, spell1Casts: 99 },
        ],
      },
    };
    const harness = makeHarness({ responses: [jsonResponse(200, rawBody)] });

    const result = await harness.client.getMatchById('americas', 'NA1_9');

    expect(result).toEqual({
      kind: 'ok',
      data: {
        metadata: { matchId: 'NA1_9', participants: ['p1'] },
        info: {
          queueId: 420,
          gameStartTimestamp: 1_726_000_000_000,
          gameDuration: 1800,
          participants: [
            { puuid: 'p1', championName: 'Ahri', win: true, kills: 5, deaths: 2, assists: 7, visionScore: 20 },
          ],
        },
      },
    });
  });
});

describe('request wiring', () => {
  it('attaches the injected API key as X-Riot-Token on every endpoint', async () => {
    const harness = makeHarness({ responses: [jsonResponse(200, [])] });

    await harness.client.getAccountByRiotId('americas', 'A', 'B');
    await harness.client.getRegionByPuuid('americas', 'lol', 'p');
    await harness.client.getSummonerByPuuid('na1', 'p');
    await harness.client.getLeagueEntriesByPuuid('na1', 'p');
    await harness.client.getMatchIdsByPuuid('americas', 'p', 20);
    await harness.client.getMatchById('americas', 'm');

    expect(harness.calls).toHaveLength(6);
    for (const call of harness.calls) {
      expect(call.init.headers[API_KEY_HEADER]).toBe(API_KEY);
      expect(call.init.method).toBe('GET');
      expect(call.init.signal.aborted).toBe(false);
    }
  });

  it('reserves a rate-limit slot with the endpoint routing value and method', async () => {
    const harness = makeHarness({ responses: [jsonResponse(200, [])] });

    await harness.client.getMatchIdsByPuuid('europe', 'p', 5);

    expect(harness.reservations).toEqual([{ routingValue: 'europe', method: RIOT_METHODS.matchIds }]);
    expect(harness.calls).toHaveLength(1);
  });

  it('reserves before the request is issued', async () => {
    const events: string[] = [];
    const rateLimitManager: RateLimitManager = {
      reserveSlot: () => {
        events.push('reserve');
        return Promise.resolve();
      },
      recordResponseHeaders: () => {
        events.push('record');
      },
    };
    const client = createRiotApiClient({
      fetch: (_url, _init) => {
        events.push('fetch');
        return Promise.resolve(jsonResponse(200, {}));
      },
      apiKey: API_KEY,
      rateLimitManager,
      sleep: () => Promise.resolve(),
      scheduleTimeout: () => () => undefined,
    });

    await client.getSummonerByPuuid('na1', 'p');

    expect(events).toEqual(['reserve', 'fetch', 'record']);
  });

  it('uses the documented per-endpoint method identifiers', async () => {
    const harness = makeHarness({ responses: [jsonResponse(200, [])] });

    await harness.client.getAccountByRiotId('americas', 'A', 'B');
    await harness.client.getRegionByPuuid('americas', 'lol', 'p');
    await harness.client.getSummonerByPuuid('na1', 'p');
    await harness.client.getLeagueEntriesByPuuid('na1', 'p');
    await harness.client.getMatchIdsByPuuid('americas', 'p', 20);
    await harness.client.getMatchById('americas', 'm');
    await harness.client.getActiveGameByPuuid('na1', 'p');
    await harness.client.getAccountByPuuid('americas', 'p');
    await harness.client.getChampionMastery('na1', 'p', 1);

    expect(harness.reservations.map((reservation) => reservation.method)).toEqual([
      'account',
      'accountRegion',
      'summoner',
      'league',
      'matchIds',
      'matchDetail',
      'spectator',
      'accountByPuuid',
      'championMastery',
    ]);
  });

  it('maps a Spectator-V5 404 to not_found — the orchestrator reads it as "not in a game" (live-game 1.2)', async () => {
    const harness = makeHarness({ responses: [jsonResponse(404, { status: { message: 'Data not found' } })] });

    const result = await harness.client.getActiveGameByPuuid('na1', 'p');

    expect(result).toEqual({ kind: 'not_found' });
  });

  it('reports the response headers back to the rate limit manager', async () => {
    const responseHeaders = headers({ 'X-App-Rate-Limit': '20:1' });
    const harness = makeHarness({ responses: [jsonResponse(200, {}, responseHeaders)] });

    await harness.client.getAccountByRiotId('americas', 'A', 'B');

    expect(harness.headerReports).toEqual([
      { routingValue: 'americas', method: RIOT_METHODS.account, headers: responseHeaders },
    ]);
  });

  it('reports response headers even for error responses', async () => {
    const responseHeaders = headers({ 'X-App-Rate-Limit': '20:1' });
    const harness = makeHarness({ responses: [jsonResponse(503, {}, responseHeaders)] });

    await harness.client.getAccountByRiotId('americas', 'A', 'B');

    expect(harness.headerReports).toHaveLength(1);
  });

  it('exposes a 10 second default timeout', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(10_000);
  });
});

describe('status mapping', () => {
  it('parses a 200 body into an ok result', async () => {
    const account = { puuid: 'p-1', gameName: 'Faker', tagLine: 'KR1' };
    const harness = makeHarness({ responses: [jsonResponse(200, account)] });

    await expect(harness.client.getAccountByRiotId('asia', 'Faker', 'KR1')).resolves.toEqual({
      kind: 'ok',
      data: account,
    });
  });

  it('parses a region-by-puuid 200 body into an ok result', async () => {
    const accountRegion = { puuid: 'p-1', game: 'lol', region: 'euw1' };
    const harness = makeHarness({ responses: [jsonResponse(200, accountRegion)] });

    await expect(harness.client.getRegionByPuuid('europe', 'lol', 'p-1')).resolves.toEqual({
      kind: 'ok',
      data: accountRegion,
    });
  });

  it('maps 404 to not_found', async () => {
    const harness = makeHarness({ responses: [jsonResponse(404, { status: { status_code: 404 } })] });

    await expect(harness.client.getAccountByRiotId('americas', 'Nope', 'NA1')).resolves.toEqual({
      kind: 'not_found',
    });
  });

  it.each([500, 502, 503, 504] as const)('maps %i to server_error carrying the status', async (status) => {
    const harness = makeHarness({ responses: [jsonResponse(status, {})] });

    await expect(harness.client.getSummonerByPuuid('na1', 'p')).resolves.toEqual({
      kind: 'server_error',
      status,
    });
  });

  it.each([401, 403] as const)('maps %i to auth_error carrying the status', async (status) => {
    const harness = makeHarness({ responses: [jsonResponse(status, {})] });

    await expect(harness.client.getSummonerByPuuid('na1', 'p')).resolves.toEqual({
      kind: 'auth_error',
      status,
    });
  });

  it.each([400, 415, 418, 204, 301] as const)(
    'maps the unmodeled status %i to server_error 502 rather than mislabeling it',
    async (status) => {
      const harness = makeHarness({ responses: [jsonResponse(status, {})] });

      await expect(harness.client.getMatchById('americas', 'm')).resolves.toEqual({
        kind: 'server_error',
        status: 502,
      });
    },
  );

  it('maps a 200 with an unparseable body to server_error 502 without throwing', async () => {
    const harness = makeHarness({
      responses: [
        {
          status: 200,
          headers: headers(),
          json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
        },
      ],
    });

    await expect(harness.client.getMatchById('americas', 'm')).resolves.toEqual({
      kind: 'server_error',
      status: 502,
    });
  });

  it('maps a transport rejection to network_error', async () => {
    const harness = makeHarness({ rejectWith: new TypeError('fetch failed') });

    await expect(harness.client.getSummonerByPuuid('na1', 'p')).resolves.toEqual({ kind: 'network_error' });
  });

  it('maps an aborted request to timeout', async () => {
    const harness = makeHarness({
      timeoutImmediately: true,
      rejectWith: Object.assign(new Error('aborted'), { name: 'AbortError' }),
    });

    await expect(harness.client.getSummonerByPuuid('na1', 'p')).resolves.toEqual({ kind: 'timeout' });
  });

  it('maps an abort-shaped rejection to timeout even without our own timer firing', async () => {
    const harness = makeHarness({ rejectWith: Object.assign(new Error('aborted'), { name: 'AbortError' }) });

    await expect(harness.client.getMatchById('americas', 'm')).resolves.toEqual({ kind: 'timeout' });
  });

  it('maps RateLimitExceededError from reserveSlot to rate_limited instead of throwing', async () => {
    const harness = makeHarness({
      reserveSlotThrows: new RateLimitExceededError('americas', 'account', 45_000),
    });

    await expect(harness.client.getAccountByRiotId('americas', 'A', 'B')).resolves.toEqual({
      kind: 'rate_limited',
    });
    expect(harness.calls).toHaveLength(0);
  });

  it('propagates a non-rate-limit error out of reserveSlot as a defect', async () => {
    const harness = makeHarness({ reserveSlotThrows: new Error('manager misconfigured') });

    await expect(harness.client.getAccountByRiotId('americas', 'A', 'B')).rejects.toThrow(
      'manager misconfigured',
    );
  });
});

describe('429 retry behavior', () => {
  it('honors Retry-After and succeeds on a retry', async () => {
    const harness = makeHarness({
      responses: [
        jsonResponse(429, {}, headers({ 'Retry-After': '3' })),
        jsonResponse(200, { puuid: 'p-1' }),
      ],
    });

    await expect(harness.client.getSummonerByPuuid('na1', 'p')).resolves.toEqual({
      kind: 'ok',
      data: { puuid: 'p-1' },
    });
    expect(harness.sleeps).toEqual([3000]);
    expect(harness.calls).toHaveLength(2);
  });

  it('waits the 5 second default when Retry-After is absent', async () => {
    const harness = makeHarness({ responses: [jsonResponse(429, {}), jsonResponse(200, {})] });

    await harness.client.getMatchById('americas', 'm');

    expect(harness.sleeps).toEqual([DEFAULT_RETRY_AFTER_SECONDS * 1000]);
  });

  it('treats a malformed Retry-After as absent', async () => {
    const harness = makeHarness({
      responses: [jsonResponse(429, {}, headers({ 'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT' })), jsonResponse(200, {})],
    });

    await harness.client.getMatchById('americas', 'm');

    expect(harness.sleeps).toEqual([DEFAULT_RETRY_AFTER_SECONDS * 1000]);
  });

  it('gives up after 2 retries and reports rate_limited with the last Retry-After', async () => {
    const harness = makeHarness({ responses: [jsonResponse(429, {}, headers({ 'Retry-After': '2' }))] });

    await expect(harness.client.getMatchIdsByPuuid('americas', 'p', 10)).resolves.toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 2,
    });
    expect(harness.calls).toHaveLength(MAX_RETRY_ATTEMPTS + 1);
    expect(harness.sleeps).toEqual([2000, 2000]);
    expect(harness.reservations).toHaveLength(MAX_RETRY_ATTEMPTS + 1);
  });

  it('does not retry 5xx, timeouts or network errors', async () => {
    const serverError = makeHarness({ responses: [jsonResponse(503, {})] });
    await serverError.client.getMatchById('americas', 'm');
    expect(serverError.calls).toHaveLength(1);
    expect(serverError.sleeps).toEqual([]);

    const network = makeHarness({ rejectWith: new TypeError('fetch failed') });
    await network.client.getMatchById('americas', 'm');
    expect(network.calls).toHaveLength(1);
    expect(network.sleeps).toEqual([]);

    const timeout = makeHarness({
      timeoutImmediately: true,
      rejectWith: Object.assign(new Error('aborted'), { name: 'AbortError' }),
    });
    await timeout.client.getMatchById('americas', 'm');
    expect(timeout.calls).toHaveLength(1);
    expect(timeout.sleeps).toEqual([]);
  });
});

describe('parseRetryAfterSeconds', () => {
  it('accepts non-negative integer seconds', () => {
    expect(parseRetryAfterSeconds('0')).toBe(0);
    expect(parseRetryAfterSeconds(' 12 ')).toBe(12);
  });

  it('rejects anything that is not integer seconds', () => {
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
    expect(parseRetryAfterSeconds(undefined)).toBeUndefined();
    expect(parseRetryAfterSeconds('')).toBeUndefined();
    expect(parseRetryAfterSeconds('-3')).toBeUndefined();
    expect(parseRetryAfterSeconds('1.5')).toBeUndefined();
    expect(parseRetryAfterSeconds('soon')).toBeUndefined();
  });
});
