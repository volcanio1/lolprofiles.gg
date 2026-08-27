import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createInMemoryCacheStore } from '../cache';
import type { LookupInput, LookupOrchestrator, LookupResult, ProfileReport } from '../orchestrator';
import { createApiRouter, type ApiLogger } from './index';
import { parseLookupRequest } from './lookup';

/**
 * Task 15.1 — `POST /api/lookup` over the real Express stack via supertest.
 *
 * The orchestrator is a recording fake, so no Riot call, no credential and no real
 * timer is involved; the cache is the real in-memory store on a fixed clock, since
 * the lookup route never touches it directly anyway.
 */

const NOW = 1_700_000_000_000;

interface Harness {
  app: Express;
  inputs: LookupInput[];
  calls: () => number;
  logged: { method: string; path: string; error: unknown }[];
}

/** `throws` models a defect in the orchestrator, which must never be swallowed. */
function makeHarness(result: LookupResult, throws?: () => never): Harness {
  const inputs: LookupInput[] = [];
  const logged: { method: string; path: string; error: unknown }[] = [];
  const now = () => NOW;

  const orchestrator: LookupOrchestrator = {
    runLookup: (input) => {
      inputs.push(input);
      if (throws !== undefined) {
        throws();
      }
      return Promise.resolve(result);
    },
  };

  const logger: ApiLogger = {
    unexpectedError: (info) => {
      logged.push(info);
    },
  };

  const app = express();
  app.use(
    '/api',
    createApiRouter({ orchestrator, cache: createInMemoryCacheStore({ now }), now, logger, dataDragonVersion: '16.17.1' }),
  );

  return { app, inputs, calls: () => inputs.length, logged };
}

function sampleReport(overrides: Partial<ProfileReport> = {}): ProfileReport {
  return {
    riotId: { gameName: 'Doffy', tagLine: 'Smile' },
    puuid: 'puuid-1',
    summonerLevel: 412,
    profileIconId: 29,
    resolvedPlatform: 'na1',
    usedPlatformOverride: false,
    stats: {
      rankedByQueue: { RANKED_SOLO_5x5: { tier: 'PLATINUM', division: 'IV', winRatePercent: 60 } },
      overallAverageKda: 3.5,
      topChampions: [
        { championName: 'Ahri', gamesPlayed: 6, winRatePercent: 50, averageKda: 3.5, averageCs: 180.25, averageCsPerMinute: 6.01 },
      ],
      mostPlayedRole: 'MIDDLE',
    },
    funFacts: [{ category: 'rolePreference', text: 'Favourite role: MIDDLE.' }],
    limitedDataNotice: false,
    recommendations: [
      { category: 'visionControl', text: 'Improve vision control.', metricName: 'averageVisionScorePerMatch', metricValue: 12.5 },
    ],
    averageMatchDurationMinutes: 30,
    recentMatches: [],
    lastUpdated: null,
    partialDataWarning: false,
    ...overrides,
  };
}

const successResult = (report: ProfileReport = sampleReport()): LookupResult => ({ kind: 'success', report });

describe('POST /api/lookup — success', () => {
  it('returns 200 with the ProfileReport unwrapped', async () => {
    const report = sampleReport();
    const harness = makeHarness(successResult(report));

    const response = await request(harness.app).post('/api/lookup').send({ riotId: 'Doffy#Smile' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(report);
    // The envelope discriminant is absent on success, so a client can branch on it.
    expect(response.body.error).toBeUndefined();
  });

  it('passes the trimmed, validated Riot ID through to the orchestrator', async () => {
    const harness = makeHarness(successResult());

    await request(harness.app).post('/api/lookup').send({ riotId: '  Doffy  #  Smile  ' });

    expect(harness.inputs[0].riotId).toEqual({ gameName: 'Doffy', tagLine: 'Smile' });
  });

  it('passes through lastUpdated as null on a first retrieval (Requirement 11.5)', async () => {
    const harness = makeHarness(successResult(sampleReport({ lastUpdated: null })));

    const response = await request(harness.app).post('/api/lookup').send({ riotId: 'Doffy#Smile' });

    expect(response.body.lastUpdated).toBeNull();
  });

  it('passes through a lastUpdated timestamp and the staleness flag (Requirements 11.3, 11.4)', async () => {
    const lastUpdated = new Date(NOW).toISOString();
    const harness = makeHarness(successResult(sampleReport({ lastUpdated, partialDataWarning: true })));

    const response = await request(harness.app).post('/api/lookup').send({ riotId: 'Doffy#Smile' });

    expect(response.body.lastUpdated).toBe(lastUpdated);
    expect(response.body.partialDataWarning).toBe(true);
  });

  it('passes through the average match duration and limited-data notice', async () => {
    const harness = makeHarness(
      successResult(sampleReport({ averageMatchDurationMinutes: 27.42, limitedDataNotice: true })),
    );

    const response = await request(harness.app).post('/api/lookup').send({ riotId: 'Doffy#Smile' });

    expect(response.body.averageMatchDurationMinutes).toBe(27.42);
    expect(response.body.limitedDataNotice).toBe(true);
  });
});

describe('POST /api/lookup — platformOverride handling (lookup-pipeline-fixes)', () => {
  it('passes no platformOverride when none is supplied', async () => {
    const harness = makeHarness(successResult());

    await request(harness.app).post('/api/lookup').send({ riotId: 'Doffy#Smile' });

    expect(harness.inputs[0].platformOverride).toBeUndefined();
  });

  it('passes a recognized platformOverride through verbatim (Requirement 2.4)', async () => {
    const harness = makeHarness(successResult());

    await request(harness.app).post('/api/lookup').send({ riotId: 'Doffy#Smile', platformOverride: 'euw1' });

    expect(harness.inputs[0].platformOverride).toBe('euw1');
  });

  it('treats a blank platformOverride as absent', async () => {
    const harness = makeHarness(successResult());

    await request(harness.app).post('/api/lookup').send({ riotId: 'Doffy#Smile', platformOverride: '   ' });

    expect(harness.inputs[0].platformOverride).toBeUndefined();
  });

  it('treats an unrecognized platformOverride as absent rather than rejecting the request (decision 2)', async () => {
    const harness = makeHarness(successResult());

    const response = await request(harness.app)
      .post('/api/lookup')
      .send({ riotId: 'Doffy#Smile', platformOverride: 'mars1' });

    expect(response.status).toBe(200);
    expect(harness.inputs[0].platformOverride).toBeUndefined();
  });

  it('rejects a request carrying a region field, without calling the orchestrator (Requirement 2.1)', async () => {
    const harness = makeHarness(successResult());

    const response = await request(harness.app)
      .post('/api/lookup')
      .send({ riotId: 'Doffy#Smile', region: 'europe' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.field).toBe('region');
    expect(harness.calls()).toBe(0);
  });

  it('rejects a request carrying a platform field, without calling the orchestrator (Requirement 2.1)', async () => {
    const harness = makeHarness(successResult());

    const response = await request(harness.app)
      .post('/api/lookup')
      .send({ riotId: 'Doffy#Smile', platform: 'euw1' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.field).toBe('platform');
    expect(harness.calls()).toBe(0);
  });
});

describe('POST /api/lookup — validation short-circuits before any Riot call (Requirement 9.1)', () => {
  const cases: { name: string; riotId: unknown; rule?: string }[] = [
    { name: 'no # at all', riotId: 'Doffy', rule: 'MISSING_HASH' },
    { name: 'more than one #', riotId: 'Doffy#Smile#Extra', rule: 'MULTIPLE_HASH' },
    { name: 'empty game name', riotId: '#Smile', rule: 'EMPTY_PART' },
    { name: 'whitespace-only tag line', riotId: 'Doffy#   ', rule: 'EMPTY_PART' },
    { name: 'game name over 16 characters', riotId: 'ThisNameIsFarTooLong#Smile', rule: 'GAME_NAME_TOO_LONG' },
    { name: 'tag line over 5 characters', riotId: 'Doffy#TooLong', rule: 'TAG_LINE_TOO_LONG' },
  ];

  for (const { name, riotId, rule } of cases) {
    it(`rejects ${name} with 400 and never calls the orchestrator`, async () => {
      const harness = makeHarness(successResult());

      const response = await request(harness.app).post('/api/lookup').send({ riotId });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.validationRule).toBe(rule);
      expect(harness.calls()).toBe(0);
    });
  }

  it('rejects a missing riotId field', async () => {
    const harness = makeHarness(successResult());

    const response = await request(harness.app).post('/api/lookup').send({ region: 'americas' });

    expect(response.status).toBe(400);
    expect(response.body.error.field).toBe('riotId');
    expect(harness.calls()).toBe(0);
  });

  it('rejects a non-string riotId without throwing', async () => {
    const harness = makeHarness(successResult());

    for (const riotId of [42, null, ['Doffy#Smile'], { gameName: 'Doffy' }, true]) {
      const response = await request(harness.app).post('/api/lookup').send({ riotId });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect(harness.calls()).toBe(0);
  });

  it('rejects a body that is not a JSON object', async () => {
    const harness = makeHarness(successResult());

    const response = await request(harness.app)
      .post('/api/lookup')
      .set('Content-Type', 'application/json')
      .send('["not","an","object"]');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(harness.calls()).toBe(0);
  });

  it('answers malformed JSON with our envelope, not an HTML page or a stack trace', async () => {
    const harness = makeHarness(successResult());

    const response = await request(harness.app)
      .post('/api/lookup')
      .set('Content-Type', 'application/json')
      .send('{ this is not json');

    expect(response.status).toBe(400);
    expect(response.type).toBe('application/json');
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(response.body)).not.toMatch(/at \w+ \(|SyntaxError/);
    expect(harness.calls()).toBe(0);
  });
});

describe('POST /api/lookup — LookupResult to HTTP mapping', () => {
  it('maps not_found to 404 echoing the submitted Riot ID (Requirements 2.4, 9.2)', async () => {
    const harness = makeHarness({ kind: 'not_found', gameName: 'Doffy', tagLine: 'Smile' });

    const response = await request(harness.app).post('/api/lookup').send({ riotId: 'Doffy#Smile' });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('PLAYER_NOT_FOUND');
    expect(response.body.error.message).toContain('Doffy#Smile');
  });

  const errorCases: { code: Parameters<typeof makeErrorResult>[0]; retriable: boolean; status: number }[] = [
    { code: 'RIOT_UNAVAILABLE', retriable: true, status: 503 },
    { code: 'TIMEOUT', retriable: false, status: 504 },
    { code: 'RATE_LIMITED', retriable: true, status: 429 },
    { code: 'AUTH_FAILURE', retriable: false, status: 503 },
    { code: 'NETWORK_ERROR', retriable: true, status: 502 },
    { code: 'MATCH_HISTORY_UNAVAILABLE', retriable: true, status: 503 },
  ];

  for (const { code, retriable, status } of errorCases) {
    it(`maps ${code} to ${String(status)}`, async () => {
      const harness = makeHarness(makeErrorResult(code, retriable));

      const response = await request(harness.app).post('/api/lookup').send({ riotId: 'Doffy#Smile' });

      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
      expect(response.body.error.retriable).toBe(retriable);
    });
  }

  it('maps NO_LOL_ACCOUNT to 404 identifying the submitted Riot ID (Requirement 5.2)', async () => {
    const harness = makeHarness({ kind: 'error', code: 'NO_LOL_ACCOUNT', retriable: false });

    const response = await request(harness.app).post('/api/lookup').send({ riotId: 'Doffy#Smile' });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NO_LOL_ACCOUNT');
    expect(response.body.error.message).toContain('Doffy#Smile');
    expect(response.body.error.retriable).toBe(false);
    expect(response.body.error.message).not.toMatch(/unavailable|temporarily/i);
  });

  it('maps UNSUPPORTED_PLATFORM to 404 naming the platform Riot reported (Requirement 5.3)', async () => {
    const harness = makeHarness({ kind: 'error', code: 'UNSUPPORTED_PLATFORM', retriable: false, platform: 'vn2' });

    const response = await request(harness.app).post('/api/lookup').send({ riotId: 'Doffy#Smile' });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('UNSUPPORTED_PLATFORM');
    expect(response.body.error.platform).toBe('vn2');
    expect(response.body.error.message).toContain('vn2');
    expect(response.body.error.retriable).toBe(false);
  });

  it('sets a Retry-After header on a rate-limited response (Requirement 9.8)', async () => {
    const harness = makeHarness(makeErrorResult('RATE_LIMITED', true));

    const response = await request(harness.app).post('/api/lookup').send({ riotId: 'Doffy#Smile' });

    expect(response.status).toBe(429);
    expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(5);
    expect(response.body.error.retryAfterSeconds).toBeGreaterThanOrEqual(5);
  });

  it('never exposes credential detail on an auth failure (Requirement 9.5)', async () => {
    const harness = makeHarness(makeErrorResult('AUTH_FAILURE', false));

    const response = await request(harness.app).post('/api/lookup').send({ riotId: 'Doffy#Smile' });

    const serialized = JSON.stringify(response.body).toLowerCase();
    for (const forbidden of ['key', 'token', 'credential', '401', '403', 'rgapi']) {
      expect(serialized, `leaked "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

describe('POST /api/lookup — defect handling', () => {
  it('logs an unexpected throw server-side and answers an opaque 500', async () => {
    const harness = makeHarness(successResult(), () => {
      throw new Error('orchestrator defect with sensitive detail');
    });

    const response = await request(harness.app).post('/api/lookup').send({ riotId: 'Doffy#Smile' });

    expect(response.status).toBe(500);
    expect(response.type).toBe('application/json');
    expect(JSON.stringify(response.body)).not.toContain('sensitive detail');
    expect(harness.logged).toHaveLength(1);
    expect(harness.logged[0].method).toBe('POST');
  });
});

describe('parseLookupRequest — pure validation', () => {
  it('accepts a well-formed request and passes through a recognized platformOverride', () => {
    const parsed = parseLookupRequest({ riotId: 'Doffy#Smile', platformOverride: 'euw1' });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.riotId).toEqual({ gameName: 'Doffy', tagLine: 'Smile' });
    expect(parsed.platformOverride).toBe('euw1');
  });

  it('drops an unrecognized platformOverride rather than rejecting the request', () => {
    const parsed = parseLookupRequest({ riotId: 'Doffy#Smile', platformOverride: 'mars1' });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.platformOverride).toBeUndefined();
  });

  it('does not throw for hostile body shapes', () => {
    for (const body of [null, undefined, 'string', 42, [], { riotId: {} }, Object.create(null)]) {
      expect(() => parseLookupRequest(body)).not.toThrow();
    }
  });
});

function makeErrorResult(
  code:
    | 'RIOT_UNAVAILABLE'
    | 'TIMEOUT'
    | 'RATE_LIMITED'
    | 'AUTH_FAILURE'
    | 'NETWORK_ERROR'
    | 'MATCH_HISTORY_UNAVAILABLE',
  retriable: boolean,
): LookupResult {
  return { kind: 'error', code, retriable };
}
