import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COOLDOWN_SECONDS,
  errorCodeForStatus,
  isProfileReport,
  lookupProfile,
  readErrorPayload,
  synthesizedError,
  type FetchLike,
} from './lookupClient';
import type { ProfileReport } from './types';

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
  return {
    riotId: { gameName: 'Doffy', tagLine: 'Smile' },
    puuid: 'p-1',
    summonerLevel: 496,
    profileIconId: 7,
    stats: { rankedByQueue: {}, overallAverageKda: 3.07, topChampions: [], mostPlayedRole: 'BOTTOM' },
    funFacts: [],
    limitedDataNotice: false,
    recommendations: [],
    averageMatchDurationMinutes: 30.38,
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

    await lookupProfile({ riotId: 'Doffy#Smile', region: 'europe' }, { fetch: fetchLike, baseUrl: BASE });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/lookup`);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ riotId: 'Doffy#Smile', region: 'europe' });
  });

  it('omits platform when none was chosen, and includes it when one was', async () => {
    const bodies: unknown[] = [];
    const fetchLike: FetchLike = (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(jsonResponse(200, sampleReport()));
    };

    await lookupProfile({ riotId: 'A#B', region: 'europe' }, { fetch: fetchLike, baseUrl: BASE });
    await lookupProfile({ riotId: 'A#B', region: 'europe', platform: '' }, { fetch: fetchLike, baseUrl: BASE });
    await lookupProfile({ riotId: 'A#B', region: 'europe', platform: 'euw1' }, { fetch: fetchLike, baseUrl: BASE });

    expect(bodies[0]).toEqual({ riotId: 'A#B', region: 'europe' });
    expect(bodies[1]).toEqual({ riotId: 'A#B', region: 'europe' });
    expect(bodies[2]).toEqual({ riotId: 'A#B', region: 'europe', platform: 'euw1' });
  });
});

describe('lookupProfile — success', () => {
  it('returns the report on 200', async () => {
    const report = sampleReport();
    const outcome = await lookupProfile(
      { riotId: 'Doffy#Smile', region: 'europe' },
      { fetch: () => Promise.resolve(jsonResponse(200, report)), baseUrl: BASE },
    );

    expect(outcome).toEqual({ kind: 'success', report });
  });

  it('treats a 200 whose body is not a report as an error, not an empty report', async () => {
    const outcome = await lookupProfile(
      { riotId: 'A#B', region: 'europe' },
      { fetch: () => Promise.resolve(jsonResponse(200, { nonsense: true })), baseUrl: BASE },
    );

    expect(outcome.kind).toBe('error');
  });

  it('treats a 200 with an unparseable body as an error', async () => {
    const outcome = await lookupProfile(
      { riotId: 'A#B', region: 'europe' },
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
        { riotId: 'A#B', region: 'europe' },
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
      { riotId: 'A#B', region: 'europe' },
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
      { riotId: 'A#B', region: 'europe' },
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
        { riotId: 'A#B', region: 'europe' },
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
      { riotId: 'A#B', region: 'europe' },
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
    for (const code of ['VALIDATION_FAILED', 'PLAYER_NOT_FOUND', 'RATE_LIMITED', 'TIMEOUT', 'AUTH_FAILURE', 'NETWORK_ERROR', 'RIOT_UNAVAILABLE', 'MATCH_HISTORY_UNAVAILABLE', 'UNSUPPORTED_REGION'] as const) {
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
