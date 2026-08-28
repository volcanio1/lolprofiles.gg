import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COOLDOWN_SECONDS,
  errorCodeForStatus,
  fetchBuildPath,
  fetchCachedReport,
  fetchSuggestions,
  isProfileReport,
  lookupProfile,
  readBuildPathResponse,
  readCachedReport,
  readErrorPayload,
  readLiveGameResponse,
  readSuggestions,
  synthesizedError,
  type FetchLike,
} from './lookupClient';
import type { ProfileReport } from './types';
import { perQueueReportFields } from '../test/reportExtras';

/**
 * The injected `fetch` means no network is touched. The timeout is exercised by
 * passing a tiny `timeoutMs` against a fetch that honors the abort signal, so no
 * test waits on the real 20-second budget.
 */

const BASE = 'http://backend.test';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function unparseableResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new Error('not json')),
  } as unknown as Response;
}

function sampleReport(overrides: Partial<ProfileReport> = {}): ProfileReport {
  const stats = { rankedByQueue: {}, overallAverageKda: 3.07, topChampions: [], mostPlayedRole: 'BOTTOM', averageMatchDurationMinutes: 28.5 };
  return {
    riotId: { gameName: 'Doffy', tagLine: 'Smile' },
    puuid: 'p-1',
    summonerLevel: 496,
    profileIconId: 7,
    resolvedPlatform: 'na1',
    usedPlatformOverride: false,
    stats,
    ...perQueueReportFields(stats),
    funFacts: [],
    limitedDataNotice: false,
    recommendations: [],
    averageMatchDurationMinutes: 30.38,
    recentMatches: [],
    lastUpdated: null,
    partialDataWarning: false,
    ...overrides,
  };
}

describe('lookupProfile — request shape', () => {
  it('posts JSON to /api/lookup on the configured base URL', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchLike: FetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(jsonResponse(200, sampleReport()));
    };

    await lookupProfile({ riotId: 'Doffy#Smile' }, { fetch: fetchLike, baseUrl: BASE });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/lookup`);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ riotId: 'Doffy#Smile' });
  });

  it('omits platformOverride when none was chosen, and includes it when one was', async () => {
    const bodies: unknown[] = [];
    const fetchLike: FetchLike = (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(jsonResponse(200, sampleReport()));
    };

    await lookupProfile({ riotId: 'A#B' }, { fetch: fetchLike, baseUrl: BASE });
    await lookupProfile({ riotId: 'A#B', platformOverride: '' }, { fetch: fetchLike, baseUrl: BASE });
    await lookupProfile({ riotId: 'A#B', platformOverride: 'euw1' }, { fetch: fetchLike, baseUrl: BASE });

    expect(bodies[0]).toEqual({ riotId: 'A#B' });
    expect(bodies[1]).toEqual({ riotId: 'A#B' });
    expect(bodies[2]).toEqual({ riotId: 'A#B', platformOverride: 'euw1' });
  });
});

describe('lookupProfile — success', () => {
  it('returns the report on 200', async () => {
    const report = sampleReport();
    const outcome = await lookupProfile(
      { riotId: 'Doffy#Smile' },
      { fetch: () => Promise.resolve(jsonResponse(200, report)), baseUrl: BASE },
    );

    expect(outcome).toEqual({ kind: 'success', report });
  });

  it('treats a 200 whose body is not a report as an error, not an empty report', async () => {
    const outcome = await lookupProfile(
      { riotId: 'A#B' },
      { fetch: () => Promise.resolve(jsonResponse(200, { nonsense: true })), baseUrl: BASE },
    );

    expect(outcome.kind).toBe('error');
  });

  it('treats a 200 with an unparseable body as an error', async () => {
    const outcome = await lookupProfile(
      { riotId: 'A#B' },
      { fetch: () => Promise.resolve(unparseableResponse(200)), baseUrl: BASE },
    );

    expect(outcome.kind).toBe('error');
  });
});

describe('lookupProfile — error mapping (Requirement 9)', () => {
  const cases: { status: number; code: string; body: unknown }[] = [
    { status: 400, code: 'VALIDATION_FAILED', body: { error: { code: 'VALIDATION_FAILED', message: 'bad', retriable: false } } },
    { status: 404, code: 'PLAYER_NOT_FOUND', body: { error: { code: 'PLAYER_NOT_FOUND', message: 'nope', retriable: false } } },
    { status: 429, code: 'RATE_LIMITED', body: { error: { code: 'RATE_LIMITED', message: 'slow down', retriable: true, retryAfterSeconds: 5 } } },
    { status: 502, code: 'NETWORK_ERROR', body: { error: { code: 'NETWORK_ERROR', message: 'conn', retriable: true } } },
    { status: 503, code: 'RIOT_UNAVAILABLE', body: { error: { code: 'RIOT_UNAVAILABLE', message: 'down', retriable: true } } },
    { status: 503, code: 'AUTH_FAILURE', body: { error: { code: 'AUTH_FAILURE', message: 'unavailable', retriable: false } } },
    { status: 504, code: 'TIMEOUT', body: { error: { code: 'TIMEOUT', message: 'timed out', retriable: false } } },
  ];

  for (const { status, code, body } of cases) {
    it(`passes through the backend's ${code} payload from a ${String(status)}`, async () => {
      const outcome = await lookupProfile(
        { riotId: 'A#B' },
        { fetch: () => Promise.resolve(jsonResponse(status, body)), baseUrl: BASE },
      );

      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') {
        return;
      }
      expect(outcome.error.code).toBe(code);
      expect(outcome.error.message.length).toBeGreaterThan(0);
    });
  }

  it('never rejects, whatever the transport does (Requirement 9.7 depends on this)', async () => {
    const outcome = await lookupProfile(
      { riotId: 'A#B' },
      { fetch: () => Promise.reject(new Error('DNS failure')), baseUrl: BASE },
    );

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') {
      return;
    }
    // Requirement 9.9: no HTTP response was received.
    expect(outcome.error.code).toBe('NETWORK_ERROR');
    expect(outcome.error.retriable).toBe(true);
  });

  it('reports a client-side timeout distinctly from a connection failure (Requirements 9.4, 9.9)', async () => {
    // Honors the abort signal, as a real fetch does, so the abort wins the race.
    const hangingFetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });

    const outcome = await lookupProfile(
      { riotId: 'A#B' },
      { fetch: hangingFetch, baseUrl: BASE, timeoutMs: 5 },
    );

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') {
      return;
    }
    expect(outcome.error.code).toBe('TIMEOUT');
  });

  it('synthesizes a payload when the body is not our envelope (proxy HTML, empty 502)', async () => {
    for (const body of [null, 'an html page', { unexpected: true }, { error: 'a string' }]) {
      const outcome = await lookupProfile(
        { riotId: 'A#B' },
        { fetch: () => Promise.resolve(jsonResponse(503, body)), baseUrl: BASE },
      );
      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') {
        return;
      }
      expect(outcome.error.code).toBe('RIOT_UNAVAILABLE');
      expect(outcome.error.message.length).toBeGreaterThan(0);
    }
  });

  it('always supplies a rate-limit cooldown of at least 5 seconds (Requirement 9.8)', async () => {
    // Backend omitted retryAfterSeconds.
    const outcome = await lookupProfile(
      { riotId: 'A#B' },
      {
        fetch: () => Promise.resolve(jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'slow', retriable: true } })),
        baseUrl: BASE,
      },
    );

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') {
      return;
    }
    expect(outcome.error.retryAfterSeconds).toBe(DEFAULT_COOLDOWN_SECONDS);
    expect(DEFAULT_COOLDOWN_SECONDS).toBeGreaterThanOrEqual(5);
  });
});

describe('response narrowing helpers', () => {
  it('infers a code from the status when the body cannot tell us', () => {
    expect(errorCodeForStatus(400)).toBe('VALIDATION_FAILED');
    expect(errorCodeForStatus(404)).toBe('PLAYER_NOT_FOUND');
    expect(errorCodeForStatus(429)).toBe('RATE_LIMITED');
    expect(errorCodeForStatus(502)).toBe('NETWORK_ERROR');
    expect(errorCodeForStatus(504)).toBe('TIMEOUT');
    expect(errorCodeForStatus(500)).toBe('RIOT_UNAVAILABLE');
    expect(errorCodeForStatus(418)).toBe('RIOT_UNAVAILABLE');
  });

  it('gives every synthesized error a non-empty message', () => {
    for (const code of ['VALIDATION_FAILED', 'PLAYER_NOT_FOUND', 'RATE_LIMITED', 'TIMEOUT', 'AUTH_FAILURE', 'NETWORK_ERROR', 'RIOT_UNAVAILABLE', 'MATCH_HISTORY_UNAVAILABLE', 'NO_LOL_ACCOUNT', 'UNSUPPORTED_PLATFORM'] as const) {
      expect(synthesizedError(code).message.length, code).toBeGreaterThan(0);
    }
  });

  it('ignores an unknown code from the body rather than rendering it raw', () => {
    const payload = readErrorPayload({ error: { code: 'WAT', message: 'x', retriable: true } }, 503);
    expect(payload.code).toBe('RIOT_UNAVAILABLE');
  });

  it('keeps the Requirement 9.2 fields when the backend supplies them', () => {
    const payload = readErrorPayload(
      { error: { code: 'PLAYER_NOT_FOUND', message: 'no', retriable: false, gameName: 'Doffy', tagLine: 'Smile' } },
      404,
    );
    expect(payload.gameName).toBe('Doffy');
    expect(payload.tagLine).toBe('Smile');
  });

  it('recognizes a report and rejects near-misses', () => {
    expect(isProfileReport(sampleReport())).toBe(true);
    expect(isProfileReport(null)).toBe(false);
    expect(isProfileReport({})).toBe(false);
    expect(isProfileReport({ ...sampleReport(), funFacts: 'nope' })).toBe(false);
    expect(isProfileReport({ ...sampleReport(), stats: null })).toBe(false);
  });
});

describe('readBuildPathResponse', () => {
  it('accepts a well-formed build_path body and keeps the skill order', () => {
    expect(
      readBuildPathResponse({
        kind: 'build_path',
        buildPath: [{ itemId: 1055, timestamp: 11000 }],
        skillOrder: [1, 2, 1, 9, 3],
        reconciled: true,
      }),
    ).toEqual({
      kind: 'build_path',
      buildPath: [{ itemId: 1055, timestamp: 11000 }],
      skillOrder: [1, 2, 1, 3], // out-of-range slot dropped
      reconciled: true,
    });
  });

  it('accepts both unavailable reasons and rejects an unknown one', () => {
    expect(readBuildPathResponse({ kind: 'unavailable', reason: 'no_timeline' })).toEqual({
      kind: 'unavailable',
      reason: 'no_timeline',
    });
    expect(readBuildPathResponse({ kind: 'unavailable', reason: 'participant_absent' })).not.toBeNull();
    expect(readBuildPathResponse({ kind: 'unavailable', reason: 'whatever' })).toBeNull();
  });

  it('rejects a malformed build_path body', () => {
    expect(readBuildPathResponse({ kind: 'build_path', buildPath: [{ itemId: 'x', timestamp: 1 }], reconciled: true })).toBeNull();
    expect(readBuildPathResponse({ kind: 'build_path', buildPath: [], reconciled: 'yes' })).toBeNull();
    expect(readBuildPathResponse(null)).toBeNull();
  });
});

describe('fetchBuildPath', () => {
  it('GETs the build-path URL with the Riot ID as query params', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchLike: FetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(jsonResponse(200, { kind: 'unavailable', reason: 'no_timeline' }));
    };

    await fetchBuildPath('EUW1_1', { gameName: 'Faker', tagLine: 'KR1' }, { fetch: fetchLike, baseUrl: BASE });

    expect(calls[0].url).toBe(`${BASE}/api/match/EUW1_1/build-path?gameName=Faker&tagLine=KR1`);
    expect(calls[0].init.method).toBe('GET');
  });

  it('returns the narrowed build_path outcome on 200', async () => {
    const fetchLike: FetchLike = () =>
      Promise.resolve(
        jsonResponse(200, {
          kind: 'build_path',
          buildPath: [{ itemId: 3006, timestamp: 5000 }],
          skillOrder: [1],
          reconciled: false,
        }),
      );
    const outcome = await fetchBuildPath('EUW1_1', { gameName: 'A', tagLine: 'B' }, { fetch: fetchLike, baseUrl: BASE });
    expect(outcome).toEqual({
      kind: 'build_path',
      buildPath: [{ itemId: 3006, timestamp: 5000 }],
      skillOrder: [1],
      reconciled: false,
    });
  });

  it('maps a non-2xx response to an error outcome', async () => {
    const fetchLike: FetchLike = () => Promise.resolve(jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'slow down', retriable: true } }));
    const outcome = await fetchBuildPath('EUW1_1', { gameName: 'A', tagLine: 'B' }, { fetch: fetchLike, baseUrl: BASE });
    expect(outcome).toEqual({ kind: 'error', error: expect.objectContaining({ code: 'RATE_LIMITED' }) });
  });

  it('treats a transport failure as a network error, never rejecting', async () => {
    const fetchLike: FetchLike = () => Promise.reject(new Error('offline'));
    const outcome = await fetchBuildPath('EUW1_1', { gameName: 'A', tagLine: 'B' }, { fetch: fetchLike, baseUrl: BASE });
    expect(outcome).toEqual({ kind: 'error', error: expect.objectContaining({ code: 'NETWORK_ERROR' }) });
  });

  it('treats an unreadable 200 body as an error, not an empty build path', async () => {
    const outcome = await fetchBuildPath('EUW1_1', { gameName: 'A', tagLine: 'B' }, { fetch: () => Promise.resolve(unparseableResponse(200)), baseUrl: BASE });
    expect(outcome.kind).toBe('error');
  });
});

describe('fetchSuggestions — autofill-search', () => {
  const rows = [
    { gameName: 'Faker', tagLine: 'KR1', profileIconId: 6, region: 'kr' },
    { gameName: 'fakerino', tagLine: 'EUW', profileIconId: null, region: 'euw1' },
  ];

  it('requests the suggest endpoint with the trimmed, encoded prefix', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchLike: FetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(jsonResponse(200, rows));
    };

    const result = await fetchSuggestions('  Fa ke ', { fetch: fetchLike, baseUrl: BASE });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/players/suggest?q=Fa%20ke`);
    expect(calls[0].init.method).toBe('GET');
    expect(result).toEqual(rows);
  });

  it('never issues a request for a below-threshold or #-containing query', async () => {
    const fetchLike: FetchLike = () => {
      throw new Error('should not be called');
    };
    for (const query of ['', ' f ', 'faker#kr']) {
      expect(await fetchSuggestions(query, { fetch: fetchLike, baseUrl: BASE })).toEqual([]);
    }
  });

  it('returns [] on a non-200 response', async () => {
    const outcome = await fetchSuggestions('faker', {
      fetch: () => Promise.resolve(jsonResponse(500, { error: 'boom' })),
      baseUrl: BASE,
    });
    expect(outcome).toEqual([]);
  });

  it('returns [] on a malformed body', async () => {
    expect(
      await fetchSuggestions('faker', { fetch: () => Promise.resolve(unparseableResponse(200)), baseUrl: BASE }),
    ).toEqual([]);
    expect(
      await fetchSuggestions('faker', { fetch: () => Promise.resolve(jsonResponse(200, { not: 'an array' })), baseUrl: BASE }),
    ).toEqual([]);
  });

  it('returns [] when the request is aborted / the transport rejects', async () => {
    const outcome = await fetchSuggestions('faker', {
      fetch: () => Promise.reject(new DOMException('aborted', 'AbortError')),
      baseUrl: BASE,
    });
    expect(outcome).toEqual([]);
  });

  it('passes the caller AbortSignal through to fetch', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    await fetchSuggestions('faker', {
      fetch: (_url, init) => {
        seen = init.signal ?? undefined;
        return Promise.resolve(jsonResponse(200, rows));
      },
      baseUrl: BASE,
      signal: controller.signal,
    });
    expect(seen).toBe(controller.signal);
  });
});

describe('fetchCachedReport — autofill-search Requirement 9', () => {
  const iso = '2026-08-20T00:00:00.000Z';

  it('requests the report endpoint and parses a cache hit', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchLike: FetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(jsonResponse(200, { source: 'cache', report: sampleReport(), fetchedAt: iso }));
    };

    const result = await fetchCachedReport('  Faker ', ' KR1 ', { fetch: fetchLike, baseUrl: BASE });

    expect(calls[0].url).toBe(`${BASE}/api/players/report?gameName=Faker&tagLine=KR1`);
    expect(calls[0].init.method).toBe('GET');
    expect(result).toEqual({ source: 'cache', report: sampleReport(), fetchedAt: iso });
  });

  it('returns miss without a request when a part is blank', async () => {
    const fetchLike: FetchLike = () => {
      throw new Error('should not be called');
    };
    expect(await fetchCachedReport('', 'KR1', { fetch: fetchLike, baseUrl: BASE })).toEqual({ source: 'miss' });
    expect(await fetchCachedReport('Faker', '  ', { fetch: fetchLike, baseUrl: BASE })).toEqual({ source: 'miss' });
  });

  it('returns miss on a non-200, a malformed body, or an abort', async () => {
    expect(
      await fetchCachedReport('Faker', 'KR1', { fetch: () => Promise.resolve(jsonResponse(500, {})), baseUrl: BASE }),
    ).toEqual({ source: 'miss' });
    expect(
      await fetchCachedReport('Faker', 'KR1', { fetch: () => Promise.resolve(unparseableResponse(200)), baseUrl: BASE }),
    ).toEqual({ source: 'miss' });
    expect(
      await fetchCachedReport('Faker', 'KR1', {
        fetch: () => Promise.reject(new DOMException('aborted', 'AbortError')),
        baseUrl: BASE,
      }),
    ).toEqual({ source: 'miss' });
  });

  it('treats a body from the server that says "miss" as a miss', async () => {
    const result = await fetchCachedReport('Faker', 'KR1', {
      fetch: () => Promise.resolve(jsonResponse(200, { source: 'miss' })),
      baseUrl: BASE,
    });
    expect(result).toEqual({ source: 'miss' });
  });
});

describe('readCachedReport', () => {
  it('downgrades a cache body with a report-shaped hole to a miss', () => {
    expect(readCachedReport({ source: 'cache', fetchedAt: 'x', report: { nope: true } })).toEqual({ source: 'miss' });
    expect(readCachedReport({ source: 'cache', report: sampleReport() })).toEqual({ source: 'miss' }); // no fetchedAt
    expect(readCachedReport(null)).toEqual({ source: 'miss' });
    expect(readCachedReport('weird')).toEqual({ source: 'miss' });
  });
});

describe('readSuggestions', () => {
  it('drops malformed rows and coerces a non-finite profileIconId to null', () => {
    expect(
      readSuggestions([
        { gameName: 'A', tagLine: 'B', profileIconId: 3, region: 'na1' },
        { gameName: 'C', tagLine: 'D', profileIconId: 'x', region: 'euw1' },
        { gameName: 'E', tagLine: 'F', region: 'kr' },
        { gameName: 42, tagLine: 'G', region: 'kr' },
        null,
        'nope',
      ]),
    ).toEqual([
      { gameName: 'A', tagLine: 'B', profileIconId: 3, region: 'na1' },
      { gameName: 'C', tagLine: 'D', profileIconId: null, region: 'euw1' },
      { gameName: 'E', tagLine: 'F', profileIconId: null, region: 'kr' },
    ]);
  });

  it('caps at MAX_SUGGESTIONS and returns [] for a non-array', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ gameName: `P${String(i)}`, tagLine: 'T', profileIconId: null, region: 'na1' }));
    expect(readSuggestions(many)).toHaveLength(8);
    expect(readSuggestions({})).toEqual([]);
  });
});

describe('readLiveGameResponse', () => {
  const participant = (over: Record<string, unknown> = {}) => ({
    puuid: 'p1',
    teamId: 100,
    championId: 1,
    spell1Id: 4,
    spell2Id: 7,
    perkIds: [8005],
    isBot: false,
    riotId: null,
    rankedEntries: null,
    championMasteryPoints: null,
    championMasteryLevel: null,
    ...over,
  });
  const lobby = (participants: unknown[]) => ({
    kind: 'in_game',
    lobby: {
      gameId: 1,
      platformId: 'EUW1',
      matchId: 'EUW1_1',
      queueId: 400,
      mapId: 11,
      gameStartTime: 1_700_000_000_000,
      bannedChampionIds: [],
      participants,
      insights: { offChampion: [], oneTricks: [], rankSpread: null },
    },
  });

  it('passes not_in_game through', () => {
    expect(readLiveGameResponse({ kind: 'not_in_game' })).toEqual({ kind: 'not_in_game' });
  });

  it('accepts an in_game lobby, including a participant Riot did not give a puuid for', () => {
    const parsed = readLiveGameResponse(lobby([participant(), participant({ puuid: '' })]));
    expect(parsed?.kind).toBe('in_game');
  });

  it('rejects a body that is not a live-game response', () => {
    expect(readLiveGameResponse({ kind: 'in_game', lobby: { matchId: 5 } })).toBeNull();
    expect(readLiveGameResponse(null)).toBeNull();
    expect(readLiveGameResponse(lobby([{ teamId: 100 }]))).toBeNull(); // participant missing fields
  });
});
