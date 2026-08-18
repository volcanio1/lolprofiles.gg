import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import fc from 'fast-check';
import { RateLimitExceededError, type RateLimitHeaders, type RateLimitManager } from '../rateLimit';
import {
  API_KEY_HEADER,
  createRiotApiClient,
  type RiotApiResult,
  type RiotHttpResponse,
  type RiotHttpTransport,
} from './index';

/**
 * Both properties run against injected fakes: no network, no real timers, no
 * clock reads. The spec constants are transcribed here rather than imported, so
 * each property compares the implementation against the requirement text instead
 * of against itself.
 */
const SPEC_DEFAULT_RETRY_AFTER_SECONDS = 5; // Requirement 4.7
const SPEC_MAX_RETRIES = 2; // Requirements 4.6-4.8

function headersFrom(values: Record<string, string> = {}): RateLimitHeaders {
  const lower = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    get(name: string): string | null {
      return lower.get(name.toLowerCase()) ?? null;
    },
  };
}

const permissiveRateLimitManager: RateLimitManager = {
  reserveSlot: () => Promise.resolve(),
  recordResponseHeaders: () => undefined,
};

/** Independent transcription of Requirement 4.6's `Retry-After` reading. */
function specRetryAfterSeconds(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const text = raw.trim();
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

// ---------------------------------------------------------------------------
// Feature: lolprofiles-gg, Property 8: 429 retry wait and retry count are bounded correctly
// **Validates: Requirements 4.6, 4.7, 4.8**
// ---------------------------------------------------------------------------

/** `undefined` = header absent; strings cover well-formed and malformed values. */
const retryAfterHeaderArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(undefined),
  fc.integer({ min: 0, max: 9 }).map((seconds) => String(seconds)),
  fc.constantFrom('', ' ', '-4', '2.5', 'later', 'Wed, 21 Oct 2015 07:28:00 GMT', '  7  '),
);

describe('Property 8: 429 retry wait and retry count are bounded correctly', () => {
  it('waits at least the required backoff, retries at most twice, and then reports rate_limited', async () => {
    const seenHeaderBranch = { present: false, absent: false };
    const seenOutcome = { ok: false, rateLimited: false };

    await fc.assert(
      fc.asyncProperty(
        fc.array(retryAfterHeaderArb, { minLength: 1, maxLength: 5 }),
        fc.boolean(),
        async (rejections, eventuallySucceeds) => {
          const calls: string[] = [];
          const sleeps: number[] = [];
          let clock = 0;

          /**
           * Serves one 429 per generated entry, then either a 200 (the retry
           * succeeds) or 429s forever (retries get exhausted).
           */
          const transport: RiotHttpTransport = (url) => {
            const attemptIndex = calls.length;
            calls.push(url);
            const declared = rejections[attemptIndex];
            if (attemptIndex < rejections.length) {
              return Promise.resolve({
                status: 429,
                headers: declared === undefined ? headersFrom() : headersFrom({ 'Retry-After': declared }),
                json: () => Promise.resolve({}),
              } satisfies RiotHttpResponse);
            }
            if (eventuallySucceeds) {
              return Promise.resolve({
                status: 200,
                headers: headersFrom(),
                json: () => Promise.resolve({ puuid: 'p-1' }),
              } satisfies RiotHttpResponse);
            }
            return Promise.resolve({
              status: 429,
              headers: headersFrom(),
              json: () => Promise.resolve({}),
            } satisfies RiotHttpResponse);
          };

          const client = createRiotApiClient({
            fetch: transport,
            apiKey: 'RGAPI-property-8',
            rateLimitManager: permissiveRateLimitManager,
            sleep: (ms) => {
              sleeps.push(ms);
              clock += ms;
              return Promise.resolve();
            },
            now: () => clock,
            scheduleTimeout: () => () => undefined,
          });

          const result = await client.getSummonerByPuuid('na1', 'p-1');

          /** Header the client saw on the nth 429 (`undefined` once past the generated list). */
          const declaredAt = (attemptIndex: number): string | undefined =>
            attemptIndex < rejections.length ? rejections[attemptIndex] : undefined;

          // Requirement 4.8: at most 2 retries, i.e. at most 3 requests, always.
          expect(calls.length).toBeLessThanOrEqual(SPEC_MAX_RETRIES + 1);
          expect(sleeps.length).toBeLessThanOrEqual(SPEC_MAX_RETRIES);
          // Every retry is preceded by exactly one wait.
          expect(sleeps.length).toBe(calls.length - 1);

          // Requirements 4.6/4.7: every wait clears the required backoff.
          sleeps.forEach((waitedMs, index) => {
            const declared = specRetryAfterSeconds(declaredAt(index));
            if (declared === undefined) {
              seenHeaderBranch.absent = true;
              expect(waitedMs).toBeGreaterThanOrEqual(SPEC_DEFAULT_RETRY_AFTER_SECONDS * 1000);
            } else {
              seenHeaderBranch.present = true;
              expect(waitedMs).toBeGreaterThanOrEqual(declared * 1000);
            }
          });
          expect(clock).toBe(sleeps.reduce((total, ms) => total + ms, 0));

          if (eventuallySucceeds && rejections.length <= SPEC_MAX_RETRIES) {
            // A retry succeeded: ok is returned and nothing further is sent.
            seenOutcome.ok = true;
            expect(result).toEqual({ kind: 'ok', data: { puuid: 'p-1' } });
            expect(calls.length).toBe(rejections.length + 1);
          } else {
            // Requirement 4.8: retries exhausted, reported as rate-limited.
            seenOutcome.rateLimited = true;
            expect(calls.length).toBe(SPEC_MAX_RETRIES + 1);
            expect(result).toEqual({
              kind: 'rate_limited',
              retryAfterSeconds: specRetryAfterSeconds(declaredAt(SPEC_MAX_RETRIES)),
            });
          }
        },
      ),
      { numRuns: 100 },
    );

    // Non-degenerate coverage: both header branches and both outcomes occurred.
    expect(seenHeaderBranch).toEqual({ present: true, absent: true });
    expect(seenOutcome).toEqual({ ok: true, rateLimited: true });
  });
});

// ---------------------------------------------------------------------------
// Feature: lolprofiles-gg, Property 6: API key is never present in any client-facing output
// **Validates: Requirements 4.2, 9.5**
// ---------------------------------------------------------------------------

/**
 * Keys including regex- and JSON-special characters, since callers may serialize
 * results. Generated keys carry Riot's `RGAPI-` prefix so that a one-character
 * random key cannot coincidentally occur inside an unrelated response body and
 * fail the property for the wrong reason; the fixed keys below cover the
 * character classes that matter.
 */
const apiKeyArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 40 }).map((value) => `RGAPI-${value}`),
  fc.constantFrom(
    'RGAPI-00000000-0000-0000-0000-000000000000',
    '.*+?()[]{}|^$',
    '{"riotApiKey":"leaked"}',
    'key\\with\\backslashes',
    'key"with"quotes',
    'key\nwith\nnewlines',
  ),
);

type Endpoint = 'account' | 'summoner' | 'league' | 'matchIds' | 'matchDetail';

type Scenario =
  | { kind: 'status'; status: number }
  | { kind: 'badJson' }
  | { kind: 'reject' }
  | { kind: 'timeout' }
  | { kind: 'reserveRefused' }
  | { kind: 'rateLimitedExhausted' };

const scenarioArb: fc.Arbitrary<Scenario> = fc.oneof(
  fc.constant<Scenario>({ kind: 'status', status: 200 }),
  fc.constant<Scenario>({ kind: 'status', status: 404 }),
  fc.constantFrom(500, 502, 503, 504).map<Scenario>((status) => ({ kind: 'status', status })),
  fc.constantFrom(401, 403).map<Scenario>((status) => ({ kind: 'status', status })),
  fc.constant<Scenario>({ kind: 'badJson' }),
  fc.constant<Scenario>({ kind: 'reject' }),
  fc.constant<Scenario>({ kind: 'timeout' }),
  fc.constant<Scenario>({ kind: 'reserveRefused' }),
  fc.constant<Scenario>({ kind: 'rateLimitedExhausted' }),
);

const endpointArb = fc.constantFrom<Endpoint>('account', 'summoner', 'league', 'matchIds', 'matchDetail');

const okBodies: Record<Endpoint, unknown> = {
  account: { puuid: 'p-1', gameName: 'Faker', tagLine: 'KR1' },
  summoner: { puuid: 'p-1', id: 's-1', summonerLevel: 500, profileIconId: 12 },
  league: [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 12, wins: 30, losses: 20 }],
  matchIds: ['NA1_1', 'NA1_2'],
  matchDetail: {
    metadata: { matchId: 'NA1_1', participants: ['p-1'] },
    info: {
      queueId: 420,
      gameStartTimestamp: 1_700_000_000_000,
      gameDuration: 1800,
      participants: [
        {
          puuid: 'p-1',
          championName: 'Ahri',
          teamPosition: 'MIDDLE',
          win: true,
          kills: 5,
          deaths: 3,
          assists: 7,
          visionScore: 20,
        },
      ],
    },
  },
};

/** Every representation a caller could plausibly derive from a result. */
function serializations(value: RiotApiResult<unknown>): string[] {
  return [
    JSON.stringify(value) ?? 'undefined',
    String(value),
    inspect(value, { depth: null, showHidden: true }),
    Object.entries(value)
      .map(([key, entry]) => `${key}=${String(entry)}`)
      .join('&'),
  ];
}

describe('Property 6: API key is never present in any client-facing output', () => {
  it('never leaks the key into a result or a thrown error, while still sending it', async () => {
    const seenKinds = new Set<string>();

    await fc.assert(
      fc.asyncProperty(apiKeyArb, endpointArb, scenarioArb, async (apiKey, endpoint, scenario) => {
        const sentHeaders: Record<string, string>[] = [];
        let fireTimeout: () => void = () => undefined;

        const transport: RiotHttpTransport = (_url, init) => {
          sentHeaders.push(init.headers);
          switch (scenario.kind) {
            case 'timeout':
              fireTimeout();
              return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            case 'reject':
              return Promise.reject(new TypeError('fetch failed'));
            case 'badJson':
              return Promise.resolve({
                status: 200,
                headers: headersFrom(),
                json: () => Promise.reject(new SyntaxError('bad json')),
              } satisfies RiotHttpResponse);
            case 'rateLimitedExhausted':
              return Promise.resolve({
                status: 429,
                headers: headersFrom({ 'Retry-After': '1' }),
                json: () => Promise.resolve({}),
              } satisfies RiotHttpResponse);
            case 'reserveRefused':
              return Promise.reject(new Error('unreachable: no request is sent when the slot is refused'));
            case 'status':
              return Promise.resolve({
                status: scenario.status,
                headers: headersFrom({ 'X-App-Rate-Limit': '20:1' }),
                json: () => Promise.resolve(okBodies[endpoint]),
              } satisfies RiotHttpResponse);
          }
        };

        const rateLimitManager: RateLimitManager = {
          reserveSlot: (routingValue, method) =>
            scenario.kind === 'reserveRefused'
              ? Promise.reject(new RateLimitExceededError(routingValue, method, 45_000))
              : Promise.resolve(),
          recordResponseHeaders: () => undefined,
        };

        const client = createRiotApiClient({
          fetch: transport,
          apiKey,
          rateLimitManager,
          sleep: () => Promise.resolve(),
          now: () => 0,
          scheduleTimeout: (_ms, onElapsed) => {
            fireTimeout = onElapsed;
            return () => {
              fireTimeout = () => undefined;
            };
          },
        });

        const invoke = (): Promise<RiotApiResult<unknown>> => {
          switch (endpoint) {
            case 'account':
              return client.getAccountByRiotId('americas', 'Faker', 'KR1');
            case 'summoner':
              return client.getSummonerByPuuid('na1', 'p-1');
            case 'league':
              return client.getLeagueEntriesByPuuid('na1', 'p-1');
            case 'matchIds':
              return client.getMatchIdsByPuuid('americas', 'p-1', 100);
            case 'matchDetail':
              return client.getMatchById('americas', 'NA1_1');
          }
        };

        let result: RiotApiResult<unknown>;
        try {
          result = await invoke();
        } catch (error: unknown) {
          // No expected outcome throws; if one ever does, it must still not carry
          // the key in its message or stack.
          const message = error instanceof Error ? error.message : String(error);
          const stack = error instanceof Error ? (error.stack ?? '') : '';
          expect(message.includes(apiKey)).toBe(false);
          expect(stack.includes(apiKey)).toBe(false);
          throw error;
        }

        seenKinds.add(result.kind);

        for (const serialized of serializations(result)) {
          expect(serialized.includes(apiKey)).toBe(false);
        }

        // Non-vacuous: the client under test really does send the key, except in
        // the one scenario where it declined to send anything at all.
        if (scenario.kind === 'reserveRefused') {
          expect(sentHeaders).toHaveLength(0);
        } else {
          expect(sentHeaders.length).toBeGreaterThan(0);
          for (const sent of sentHeaders) {
            expect(sent[API_KEY_HEADER]).toBe(apiKey);
          }
        }
      }),
      { numRuns: 100 },
    );

    // Non-degenerate coverage: every result variant was exercised.
    expect([...seenKinds].sort()).toEqual(
      ['auth_error', 'network_error', 'not_found', 'ok', 'rate_limited', 'server_error', 'timeout'].sort(),
    );
  });
});
