import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { TTL_BY_ENDPOINT, createInMemoryCacheStore, type CacheKey, type InMemoryCacheStore } from '../cache';
import { standingForQueue } from '../insight/stats';
import type {
  AccountDto,
  AccountRegionDto,
  LeagueEntryDto,
  MatchDto,
  RiotApiClient,
  RiotApiResult,
  SummonerDto,
} from '../riotApiClient';
import { createLookupOrchestrator, type LookupResult, type LookupStage } from './index';
import type { RiotApiFailure } from './cacheOrFetch';

/**
 * Properties 2, 4 and 5 (tasks 13.5, 13.6 and 13.7).
 *
 * The Riot API client and the clock are fakes; the cache is the real
 * `InMemoryCacheStore` driven by a fake clock, so cache semantics are exercised
 * rather than simulated. The budget timer is injected and never fires in this
 * file, so the 15s path is out of scope here (it is covered by example tests) and
 * no real timer is ever armed.
 */

const PUUID = 'puuid-property';
const REGION = 'americas';
const PLATFORM = 'na1';
const GAME_NAME = 'Prop';
const TAG_LINE = 'TEST';

/** Requirement 3.5's allowed queue ids, and ids that must be excluded. */
const ALLOWED_QUEUE_IDS = [400, 420, 430, 440, 480, 490, 710] as const;
const DISALLOWED_QUEUE_IDS = [0, 450, 460, 470, 700, 720, 900, 1700, 2, 4] as const;

/** Fires no budget: `runLookup` must complete on the pipeline's own terms. */
const neverFiringScheduler = () => () => undefined;

interface ClientScript {
  account?: RiotApiResult<AccountDto>;
  /** Defaults to a `na1` (Requirement REGION/PLATFORM-consistent) resolution. */
  regionResolution?: RiotApiResult<AccountRegionDto>;
  summoner?: RiotApiResult<SummonerDto>;
  league?: RiotApiResult<LeagueEntryDto[]>;
  matchIds?: RiotApiResult<string[]>;
  matchDetail?: (matchId: string) => RiotApiResult<MatchDto>;
}

interface Harness {
  result: Promise<LookupResult>;
  calls: { stage: LookupStage; detail?: string }[];
}

function accountDto(): AccountDto {
  return { puuid: PUUID, gameName: GAME_NAME, tagLine: TAG_LINE };
}

function summonerDto(level: number): SummonerDto {
  return { puuid: PUUID, id: 'sid', summonerLevel: level, profileIconId: 7 };
}

interface MatchShape {
  matchId: string;
  queueId: number;
  durationSeconds: number;
  win: boolean;
}

function matchDto(shape: MatchShape): MatchDto {
  return {
    metadata: { matchId: shape.matchId, participants: [PUUID] },
    info: {
      queueId: shape.queueId,
      gameStartTimestamp: 1_700_000_000_000,
      gameDuration: shape.durationSeconds,
      participants: [
        {
          puuid: PUUID,
          championName: 'Ahri',
          teamPosition: 'MIDDLE',
          win: shape.win,
          kills: 5,
          deaths: 5,
          assists: 5,
          visionScore: 20,
        },
      ],
    },
  };
}

function runLookupWith(script: ClientScript, cache: InMemoryCacheStore, now: () => number): Harness {
  const calls: { stage: LookupStage; detail?: string }[] = [];
  const client: RiotApiClient = {
    getAccountByRiotId: (_region, gameName, tagLine) => {
      calls.push({ stage: 'account', detail: `${gameName}#${tagLine}` });
      return Promise.resolve(script.account ?? { kind: 'ok', data: accountDto() });
    },
    getRegionByPuuid: (_region, _game, puuid) => {
      calls.push({ stage: 'regionResolution', detail: puuid });
      return Promise.resolve(
        script.regionResolution ?? { kind: 'ok', data: { puuid, game: 'lol', region: PLATFORM } },
      );
    },
    getSummonerByPuuid: (_platform, puuid) => {
      calls.push({ stage: 'summoner', detail: puuid });
      return Promise.resolve(script.summoner ?? { kind: 'ok', data: summonerDto(100) });
    },
    getLeagueEntriesByPuuid: (_platform, puuid) => {
      calls.push({ stage: 'league', detail: puuid });
      return Promise.resolve(script.league ?? { kind: 'ok', data: [] });
    },
    getMatchIdsByPuuid: (_region, puuid) => {
      calls.push({ stage: 'matchIds', detail: puuid });
      return Promise.resolve(script.matchIds ?? { kind: 'ok', data: [] });
    },
    getMatchById: (_region, matchId) => {
      calls.push({ stage: 'matchDetail', detail: matchId });
      return Promise.resolve(script.matchDetail?.(matchId) ?? { kind: 'ok', data: matchDto({ matchId, queueId: 420, durationSeconds: 1_800, win: true }) });
    },
    getMatchTimeline: () => Promise.reject(new Error('getMatchTimeline not exercised by the lookup path')),
  };

  const orchestrator = createLookupOrchestrator({
    cache,
    riotApiClient: client,
    now,
    scheduleTimeout: neverFiringScheduler,
    logger: { authFailure: () => undefined },
  });

  return {
    calls,
    result: orchestrator.runLookup({ riotId: { gameName: GAME_NAME, tagLine: TAG_LINE } }),
  };
}

const failureArb: fc.Arbitrary<RiotApiFailure> = fc.oneof(
  fc.constant<RiotApiFailure>({ kind: 'not_found' }),
  fc.constant<RiotApiFailure>({ kind: 'rate_limited' }),
  fc.constantFrom<500 | 502 | 503 | 504>(500, 502, 503, 504).map<RiotApiFailure>((status) => ({
    kind: 'server_error',
    status,
  })),
  fc.constantFrom<401 | 403>(401, 403).map<RiotApiFailure>((status) => ({ kind: 'auth_error', status })),
  fc.constant<RiotApiFailure>({ kind: 'timeout' }),
  fc.constant<RiotApiFailure>({ kind: 'network_error' }),
);

/**
 * Error-code oracle, transcribed from the requirements rather than imported, so
 * the property compares the module against the specification:
 *  - 9.5 a rejected credential is a generic auth failure, whatever the stage
 *  - 9.4 a 10s overrun is a timeout
 *  - 9.8 a 429 is rate-limited
 *  - 9.9 a transport failure with no HTTP response is a network error
 *  - 3.6 a match-ids failure says match history is unavailable
 *  - 9.3 anything else Riot could not serve is temporary unavailability
 */
function expectedErrorCode(stage: 'league' | 'matchIds', failure: RiotApiFailure): string {
  switch (failure.kind) {
    case 'auth_error':
      return 'AUTH_FAILURE';
    case 'timeout':
      return 'TIMEOUT';
    case 'rate_limited':
      return 'RATE_LIMITED';
    case 'network_error':
      return 'NETWORK_ERROR';
    case 'not_found':
      return stage === 'matchIds' ? 'MATCH_HISTORY_UNAVAILABLE' : 'RIOT_UNAVAILABLE';
    default:
      return stage === 'matchIds' ? 'MATCH_HISTORY_UNAVAILABLE' : 'RIOT_UNAVAILABLE';
  }
}

describe('Lookup Orchestrator halting properties', () => {
  // Feature: lolprofiles-gg, Property 2: Account-not-found halts the pipeline and leaves no partial state
  // **Validates: Requirements 2.4, 2.7, 3.6**
  //
  // Reading of the property text, per design.md's sequence-flow section:
  //  - "any ... Match-V5 call fails" means the match-ids-by-puuid call. An
  //    individual match-by-id failure is explicitly an exclusion that does NOT
  //    halt (Requirement 3.3, and design.md's error table lists the two rows
  //    separately); Property 5 below covers that case.
  //  - "never returns a success result containing partial or stale data for that
  //    session" is the prohibition on SYNTHESIS. design.md resolves the tension
  //    with Requirement 11.3 explicitly: the orchestrator "does not synthesize a
  //    partial report: it either falls back to the most recent fully-cached report
  //    with a staleness indicator (Requirement 11.3), or if no prior cached report
  //    exists, returns an error result (Requirement 2.7 / 3.6)." So a success is
  //    permitted after a downstream failure only when EVERY required component is
  //    available and the report is flagged with `partialDataWarning`; when any
  //    component is missing there must be no report at all.
  it('halts on account-not-found without touching downstream endpoints or persisting anything', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 5 }),
        async (start, matchIds) => {
          const now = () => start;
          const cache = createInMemoryCacheStore({ now });
          const harness = runLookupWith(
            { account: { kind: 'not_found' }, matchIds: { kind: 'ok', data: matchIds } },
            cache,
            now,
          );

          const result = await harness.result;

          // Requirements 2.4 / 9.2: not found, with the submitted Riot ID echoed.
          expect(result).toEqual({ kind: 'not_found', gameName: GAME_NAME, tagLine: TAG_LINE });
          // No Summoner-V4, League-V4 or Match-V5 call was issued.
          expect(harness.calls.map((call) => call.stage)).toEqual(['account']);
          // No partial state was retained for the session.
          expect(cache.size).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('never synthesizes a report when a required post-PUUID call fails (Summoner-V4 is no longer among the required, per Requirement 4.5)', async () => {
    type Stage = 'league' | 'matchIds';
    const STAGES: readonly Stage[] = ['league', 'matchIds'];

    const caseArb = fc.record({
      failing: fc
        .array(fc.constantFrom<Stage>('league', 'matchIds'), { minLength: 1, maxLength: 2 })
        .map((stages) => [...new Set(stages)]),
      failure: failureArb,
      /** Which components a PRIOR session had left in the cache. */
      seeded: fc.record({
        league: fc.boolean(),
        matchIds: fc.boolean(),
      }),
      start: fc.integer({ min: 1, max: 1_000_000 }),
    });

    let successCount = 0;
    let errorCount = 0;
    const failureKinds = new Set<string>();

    await fc.assert(
      fc.asyncProperty(caseArb, async ({ failing, failure, seeded, start }) => {
        failureKinds.add(failure.kind);
        let clock = start;
        const cache = createInMemoryCacheStore({ now: () => clock });

        // A prior session's leftovers. Seeded at `start`, then aged past every
        // finite TTL so this session must attempt a refresh and therefore really
        // does hit the failure under test.
        const seedEntries: { key: CacheKey; value: unknown; ttl: number | 'infinite' }[] = [];
        if (seeded.league) {
          seedEntries.push({
            key: { endpoint: 'league', routingValue: PLATFORM, params: { puuid: PUUID } },
            value: [
              { queueType: 'RANKED_SOLO_5x5', tier: 'BRONZE', rank: 'III', leaguePoints: 1, wins: 1, losses: 1 },
            ],
            ttl: TTL_BY_ENDPOINT.league,
          });
        }
        if (seeded.matchIds) {
          seedEntries.push({
            key: { endpoint: 'matchIds', routingValue: REGION, params: { puuid: PUUID } },
            value: ['seed-1'],
            ttl: TTL_BY_ENDPOINT.matchIds,
          });
          seedEntries.push({
            key: { endpoint: 'matchDetail', routingValue: REGION, params: { matchId: 'seed-1' } },
            value: matchDto({ matchId: 'seed-1', queueId: 420, durationSeconds: 1_200, win: true }),
            ttl: TTL_BY_ENDPOINT.matchDetail,
          });
        }
        for (const entry of seedEntries) {
          await cache.set(entry.key, entry.value, entry.ttl);
        }
        clock = start + (TTL_BY_ENDPOINT.summoner as number) + 1;

        const script: ClientScript = {
          // Summoner-V4 always succeeds and is irrelevant to this property — it
          // cannot influence success/error classification at all (Requirement 4.5).
          league: failing.includes('league') ? failure : { kind: 'ok', data: [] },
          matchIds: failing.includes('matchIds') ? failure : { kind: 'ok', data: [] },
        };

        const harness = runLookupWith(script, cache, () => clock);
        const result = await harness.result;

        // Oracle: the Requirement 11.3 fallback needs a COMPLETE snapshot. A
        // component is available if a prior session cached it or this session
        // fetched it successfully.
        const available = (stage: Stage): boolean => seeded[stage] || !failing.includes(stage);
        const fallbackPossible = STAGES.every(available);

        if (fallbackPossible) {
          successCount += 1;
          expect(result.kind).toBe('success');
          if (result.kind !== 'success') {
            return;
          }
          // Requirement 11.3: the staleness indication is mandatory. A success
          // after a downstream failure may never look like a clean fresh report.
          expect(result.report.partialDataWarning).toBe(true);
          // Nothing is missing or defaulted: the report is complete, not partial.
          expect(result.report.puuid).toBe(PUUID);
          // Enrichment is never cached (design.md), so every fallback report has
          // null summoner fields — this is not itself evidence of an incomplete
          // report, per Requirement 4.2.
          expect(result.report.summonerLevel).toBeNull();
          expect(result.report.lastUpdated).not.toBeNull();
          expect(result.report.stats).toBeDefined();
          expect(Array.isArray(result.report.funFacts)).toBe(true);
          expect(Array.isArray(result.report.recommendations)).toBe(true);
        } else {
          errorCount += 1;
          // Requirements 2.7 / 3.6: no report at all.
          expect(result.kind).toBe('error');
          if (result.kind !== 'error') {
            return;
          }
          const firstFailing = STAGES.find((stage) => failing.includes(stage));
          expect(result.code).toBe(expectedErrorCode(firstFailing as Stage, failure));
        }

        // In neither branch is a success ever returned without the warning.
        if (result.kind === 'success') {
          expect(result.report.partialDataWarning).toBe(true);
        }
      }),
      {
        numRuns: 300,
        /**
         * Deterministic coverage (see Property 5's note): every failure kind, plus
         * both the fallback-possible and fallback-impossible branches, regardless
         * of seed.
         */
        examples: (
          [
            { kind: 'not_found' },
            { kind: 'rate_limited' },
            { kind: 'server_error', status: 503 },
            { kind: 'auth_error', status: 401 },
            { kind: 'timeout' },
            { kind: 'network_error' },
          ] as RiotApiFailure[]
        ).flatMap((failure, index) => [
          // Fallback possible: everything the failing stage needs is already cached.
          [
            {
              failing: ['league'] as ('league' | 'matchIds')[],
              failure,
              seeded: { league: true, matchIds: true },
              start: 1_000 + index,
            },
          ] as const,
          // Fallback impossible: nothing cached, so it must be an error.
          [
            {
              failing: ['league'] as ('league' | 'matchIds')[],
              failure,
              seeded: { league: false, matchIds: false },
              start: 2_000 + index,
            },
          ] as const,
        ]) as [
          {
            failing: ('league' | 'matchIds')[];
            failure: RiotApiFailure;
            seeded: { league: boolean; matchIds: boolean };
            start: number;
          },
        ][],
      },
    );

    // Guard against degenerate coverage: both outcomes and every failure kind.
    expect(successCount).toBeGreaterThan(0);
    expect(errorCount).toBeGreaterThan(0);
    expect(failureKinds.size).toBe(6);
  });
});

describe('Lookup Orchestrator match-history properties', () => {
  // Feature: lolprofiles-gg, Property 5: Match fetch failures and disallowed queue types are excluded without halting processing
  // **Validates: Requirements 3.3, 3.4, 3.5**
  it('includes exactly the successfully fetched, allowed-queue matches, attempts every id, and ties the notice to the included count', async () => {
    interface Spec {
      fetchOk: boolean;
      queueId: number;
      /** Distinct per index, so the average duration fingerprints the exact set. */
      minutes: number;
    }

    const specArb = fc.array(
      fc.record({
        fetchOk: fc.boolean(),
        queueId: fc.oneof(fc.constantFrom(...ALLOWED_QUEUE_IDS), fc.constantFrom(...DISALLOWED_QUEUE_IDS)),
      }),
      { minLength: 0, maxLength: 14 },
    );

    let noticeOnCount = 0;
    let noticeOffCount = 0;
    let excludedByFailureCount = 0;
    let excludedByQueueCount = 0;
    let emptyIncludedCount = 0;

    await fc.assert(
      fc.asyncProperty(specArb, fc.integer({ min: 1, max: 5 }), async (rawSpecs, concurrency) => {
        const specs: Spec[] = rawSpecs.map((spec, index) => ({ ...spec, minutes: index + 1 }));
        const matchIds = specs.map((_spec, index) => `m${String(index)}`);
        const byId = new Map(matchIds.map((matchId, index) => [matchId, specs[index]]));

        const clock = 500_000;
        const cache = createInMemoryCacheStore({ now: () => clock });
        const calls: { stage: LookupStage; detail?: string }[] = [];

        const client: RiotApiClient = {
          getAccountByRiotId: () => {
            calls.push({ stage: 'account' });
            return Promise.resolve<RiotApiResult<AccountDto>>({ kind: 'ok', data: accountDto() });
          },
          getRegionByPuuid: (_region, _game, puuid) => {
            calls.push({ stage: 'regionResolution' });
            return Promise.resolve<RiotApiResult<AccountRegionDto>>({
              kind: 'ok',
              data: { puuid, game: 'lol', region: PLATFORM },
            });
          },
          getSummonerByPuuid: () => {
            calls.push({ stage: 'summoner' });
            return Promise.resolve<RiotApiResult<SummonerDto>>({ kind: 'ok', data: summonerDto(100) });
          },
          getLeagueEntriesByPuuid: () => {
            calls.push({ stage: 'league' });
            return Promise.resolve<RiotApiResult<LeagueEntryDto[]>>({ kind: 'ok', data: [] });
          },
          getMatchIdsByPuuid: () => {
            calls.push({ stage: 'matchIds' });
            return Promise.resolve<RiotApiResult<string[]>>({ kind: 'ok', data: matchIds });
          },
          getMatchById: (_region, matchId) => {
            calls.push({ stage: 'matchDetail', detail: matchId });
            const spec = byId.get(matchId);
            if (spec === undefined || !spec.fetchOk) {
              // Requirement 3.3 names timeout and rate limiting explicitly.
              return Promise.resolve<RiotApiResult<MatchDto>>({ kind: 'timeout' });
            }
            return Promise.resolve<RiotApiResult<MatchDto>>({
              kind: 'ok',
              data: matchDto({
                matchId,
                queueId: spec.queueId,
                durationSeconds: spec.minutes * 60,
                win: true,
              }),
            });
          },
          getMatchTimeline: () => Promise.reject(new Error('getMatchTimeline not exercised by the lookup path')),
        };

        const orchestrator = createLookupOrchestrator({
          cache,
          riotApiClient: client,
          now: () => clock,
          scheduleTimeout: neverFiringScheduler,
          logger: { authFailure: () => undefined },
          matchDetailConcurrency: concurrency,
        });

        const result = await orchestrator.runLookup({
          riotId: { gameName: GAME_NAME, tagLine: TAG_LINE },
        });

        // Independent oracle, stated from Requirements 3.3/3.5 rather than by
        // calling the implementation: a match counts if and only if it was
        // fetched successfully AND its queue id is one of the allowed ones.
        const allowed = new Set<number>(ALLOWED_QUEUE_IDS);
        const includedSpecs = specs.filter((spec) => spec.fetchOk && allowed.has(spec.queueId));
        if (specs.some((spec) => !spec.fetchOk)) {
          excludedByFailureCount += 1;
        }
        if (specs.some((spec) => spec.fetchOk && !allowed.has(spec.queueId))) {
          excludedByQueueCount += 1;
        }

        // Processing never halts: individual failures are exclusions.
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') {
          return;
        }

        // Every match id was attempted, in order, regardless of earlier failures.
        expect(calls.filter((call) => call.stage === 'matchDetail').map((call) => call.detail)).toEqual(matchIds);

        // The included set is exactly the expected one. Every included match uses
        // the same champion, so the count is directly observable, and the minutes
        // are distinct per index, so the average pins down the exact membership.
        if (includedSpecs.length === 0) {
          emptyIncludedCount += 1;
          expect(result.report.stats.topChampions).toEqual([]);
          expect(result.report.averageMatchDurationMinutes).toBe(0);
        } else {
          expect(result.report.stats.topChampions).toHaveLength(1);
          expect(result.report.stats.topChampions[0].gamesPlayed).toBe(includedSpecs.length);
          const expectedAverage =
            includedSpecs.reduce((total, spec) => total + spec.minutes, 0) / includedSpecs.length;
          expect(result.report.averageMatchDurationMinutes).toBeCloseTo(expectedAverage, 2);
        }

        // Requirement 3.4: the notice tracks the INCLUDED count, not the attempted one.
        expect(result.report.limitedDataNotice).toBe(includedSpecs.length < 5);
        if (result.report.limitedDataNotice) {
          noticeOnCount += 1;
        } else {
          noticeOffCount += 1;
        }
      }),
      {
        numRuns: 300,
        /**
         * These two examples run BEFORE any random generation, which is what makes
         * the coverage guards below guarantees rather than likelihoods. Without
         * them the guards depend on the seed: reaching 5 included matches needs a
         * long array whose entries mostly survive both exclusion filters, which a
         * given seed may simply never produce, and a spuriously failing coverage
         * guard is worse than no guard at all.
         *
         * The first example carries 5 included matches (notice off), one fetch
         * failure, and one disallowed queue; the second is the empty window.
         */
        examples: [
          [
            [
              { fetchOk: true, queueId: 420 },
              { fetchOk: true, queueId: 440 },
              { fetchOk: true, queueId: 400 },
              { fetchOk: true, queueId: 430 },
              { fetchOk: true, queueId: 490 },
              { fetchOk: false, queueId: 420 },
              { fetchOk: true, queueId: 450 },
            ],
            3,
          ],
          [[], 1],
        ],
      },
    );

    // Guard against degenerate coverage: both notice branches and both exclusion
    // reasons must have been exercised, including the all-excluded case.
    expect(noticeOnCount).toBeGreaterThan(0);
    expect(noticeOffCount).toBeGreaterThan(0);
    expect(excludedByFailureCount).toBeGreaterThan(0);
    expect(excludedByQueueCount).toBeGreaterThan(0);
    expect(emptyIncludedCount).toBeGreaterThan(0);
  });
});

describe('Lookup Orchestrator unranked properties', () => {
  // Feature: lolprofiles-gg, Property 4: Unranked queues never treated as failures
  // **Validates: Requirements 2.8, 6.1**
  it('renders every queue type without an entry as Unranked and never fails on an empty entry set', async () => {
    const QUEUE_POOL = [
      'RANKED_SOLO_5x5',
      'RANKED_FLEX_SR',
      'RANKED_TFT',
      'RANKED_FLEX_TT',
      'CHERRY',
    ] as const;

    // Zero is drawn deliberately often, so a 0-0 record — Requirement 6.6's
    // 'N/A' win rate — is actually reachable rather than a 1-in-40000 accident.
    const countArb = fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 200 }));
    const entryArb = fc.record({
      queueType: fc.constantFrom(...QUEUE_POOL),
      tier: fc.constantFrom('IRON', 'BRONZE', 'GOLD', 'PLATINUM', 'CHALLENGER'),
      rank: fc.constantFrom('I', 'II', 'III', 'IV'),
      leaguePoints: fc.integer({ min: 0, max: 100 }),
      wins: countArb,
      losses: countArb,
    });

    let emptySetCount = 0;
    let unrankedQueueCount = 0;
    let rankedQueueCount = 0;
    let naWinRateCount = 0;

    await fc.assert(
      fc.asyncProperty(
        fc.array(entryArb, { maxLength: 5 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        async (entries, start) => {
          const now = () => start;
          const cache = createInMemoryCacheStore({ now });
          const harness = runLookupWith({ league: { kind: 'ok', data: entries } }, cache, now);

          const result = await harness.result;

          // An empty entry set is never a failure (Requirement 2.8).
          expect(result.kind).toBe('success');
          if (result.kind !== 'success') {
            return;
          }
          if (entries.length === 0) {
            emptySetCount += 1;
            expect(result.report.stats.rankedByQueue).toEqual({});
          }

          // Independent oracle: first entry per queue type wins; win rate is
          // 'N/A' exactly when wins + losses is 0 (Requirements 6.2 / 6.6).
          const expected = new Map<string, { tier: string; division: string; winRatePercent: number | 'N/A' }>();
          for (const entry of entries) {
            if (expected.has(entry.queueType)) {
              continue;
            }
            const total = entry.wins + entry.losses;
            expected.set(entry.queueType, {
              tier: entry.tier,
              division: entry.rank,
              winRatePercent: total === 0 ? 'N/A' : Math.round((100 * entry.wins) / total),
            });
          }

          for (const queueType of QUEUE_POOL) {
            const standing = standingForQueue(result.report.stats, queueType);
            const expectedStanding = expected.get(queueType);
            if (expectedStanding === undefined) {
              // No entry for this queue type: rendered as Unranked, not absent.
              unrankedQueueCount += 1;
              expect(standing).toBe('Unranked');
            } else {
              rankedQueueCount += 1;
              // An explicitly present entry is never Unranked.
              expect(standing).not.toBe('Unranked');
              expect(standing).toEqual(expectedStanding);
              if (expectedStanding.winRatePercent === 'N/A') {
                naWinRateCount += 1;
              }
            }
          }
        },
      ),
      {
        numRuns: 300,
        /**
         * Deterministic coverage (see Property 5's note). The empty entry set is
         * Requirement 2.8's case, and the 0-0 record is Requirement 6.6's 'N/A'
         * win rate — which a random draw hits only by accident.
         */
        examples: [
          [[], 10],
          [
            [
              { queueType: 'RANKED_SOLO_5x5' as const, tier: 'GOLD', rank: 'II', leaguePoints: 30, wins: 0, losses: 0 },
              { queueType: 'RANKED_FLEX_SR' as const, tier: 'IRON', rank: 'IV', leaguePoints: 0, wins: 3, losses: 7 },
            ],
            20,
          ],
        ],
      },
    );

    // Guard against degenerate coverage.
    expect(emptySetCount).toBeGreaterThan(0);
    expect(unrankedQueueCount).toBeGreaterThan(0);
    expect(rankedQueueCount).toBeGreaterThan(0);
    expect(naWinRateCount).toBeGreaterThan(0);
  });
});
