import { describe, it, expect } from 'vitest';
import {
  TTL_BY_ENDPOINT,
  createInMemoryCacheStore,
  type CacheKey,
  type CacheStore,
  type InMemoryCacheStore,
} from '../cache';
import {
  createInMemoryRankHistoryStore,
  type RankHistoryStore,
} from '../db/rankHistoryStore';
import {
  createInMemoryLookedUpPlayerStore,
  type LookedUpPlayerStore,
} from '../db/lookedUpPlayerStore';
import type { PlatformRoutingValue } from '../region';
import type {
  AccountDto,
  AccountRegionDto,
  LeagueEntryDto,
  MatchDto,
  RiotApiClient,
  RiotApiResult,
  SummonerDto,
  TimeoutScheduler,
} from '../riotApiClient';
import {
  FRESH_PATH_BUDGET_MS,
  MATCH_HISTORY_COUNT,
  createLookupOrchestrator,
  lastUpdatedOf,
  type LookupLogger,
  type LookupResult,
  type LookupStage,
} from './index';

/**
 * Example tests for `runLookup` (task 13.4).
 *
 * Every collaborator is a fake: the Riot API client never touches a network, the
 * clock is a mutable counter, and the budget timer only fires when a test says
 * so. No real timer is armed, and no credential exists in this file — the
 * orchestrator never sees one, since the client owns the key.
 */

const PUUID = 'puuid-doffy';
const GAME_NAME = 'Doffy';
const TAG_LINE = 'Smile';

interface RecordedCall {
  stage: LookupStage;
  routingValue: string;
  detail?: string;
}

interface ClientScript {
  account?: RiotApiResult<AccountDto>;
  /**
   * Defaults to a `na1` resolution, chosen so this fake's default routing
   * matches the OLD default-region test expectations (`americas`/`na1`) without
   * every test needing to configure it explicitly.
   */
  regionResolution?: RiotApiResult<AccountRegionDto>;
  summoner?: RiotApiResult<SummonerDto>;
  league?: RiotApiResult<LeagueEntryDto[]>;
  matchIds?: RiotApiResult<string[]>;
  /** Per-match-id outcome, so individual failures can be targeted. */
  matchDetail?: (matchId: string) => RiotApiResult<MatchDto>;
  /** Runs before each call resolves, so a test can fire the budget mid-pipeline. */
  onCall?: (stage: LookupStage, detail?: string) => void;
}

interface Fakes {
  client: RiotApiClient;
  calls: RecordedCall[];
  callsAt: (stage: LookupStage) => RecordedCall[];
}

function account(overrides: Partial<AccountDto> = {}): AccountDto {
  return { puuid: PUUID, gameName: GAME_NAME, tagLine: TAG_LINE, ...overrides };
}

function summoner(overrides: Partial<SummonerDto> = {}): SummonerDto {
  return { puuid: PUUID, id: 'summoner-id', summonerLevel: 412, profileIconId: 29, ...overrides };
}

function leagueEntry(overrides: Partial<LeagueEntryDto> = {}): LeagueEntryDto {
  return {
    queueType: 'RANKED_SOLO_5x5',
    tier: 'PLATINUM',
    rank: 'IV',
    leaguePoints: 51,
    wins: 60,
    losses: 40,
    ...overrides,
  };
}

interface MatchOptions {
  queueId?: number;
  championName?: string;
  role?: string;
  win?: boolean;
  kills?: number;
  deaths?: number;
  assists?: number;
  visionScore?: number;
  startTimestamp?: number;
  durationSeconds?: number;
  puuid?: string;
}

function matchDto(matchId: string, options: MatchOptions = {}): MatchDto {
  const puuid = options.puuid ?? PUUID;
  return {
    metadata: { matchId, participants: [puuid, 'other-1'] },
    info: {
      queueId: options.queueId ?? 420,
      gameStartTimestamp: options.startTimestamp ?? 1_700_000_000_000,
      gameDuration: options.durationSeconds ?? 1_800,
      participants: [
        {
          puuid,
          championName: options.championName ?? 'Ahri',
          teamPosition: options.role ?? 'MIDDLE',
          win: options.win ?? true,
          kills: options.kills ?? 6,
          deaths: options.deaths ?? 2,
          assists: options.assists ?? 8,
          visionScore: options.visionScore ?? 20,
        },
        {
          puuid: 'other-1',
          championName: 'Garen',
          teamPosition: 'TOP',
          win: false,
          kills: 1,
          deaths: 9,
          assists: 2,
          visionScore: 5,
        },
      ],
    },
  };
}

function makeFakes(script: ClientScript = {}): Fakes {
  const calls: RecordedCall[] = [];

  const record = <T>(stage: LookupStage, routingValue: string, result: RiotApiResult<T>, detail?: string) => {
    calls.push({ stage, routingValue, detail });
    script.onCall?.(stage, detail);
    return Promise.resolve(result);
  };

  const client: RiotApiClient = {
    getAccountByRiotId: (region, gameName, tagLine) =>
      record('account', region, script.account ?? { kind: 'ok', data: account() }, `${gameName}#${tagLine}`),
    getRegionByPuuid: (region, _game, puuid) =>
      record(
        'regionResolution',
        region,
        script.regionResolution ?? { kind: 'ok', data: { puuid, game: 'lol', region: 'na1' } },
        puuid,
      ),
    getSummonerByPuuid: (platform, puuid) =>
      record('summoner', platform, script.summoner ?? { kind: 'ok', data: summoner() }, puuid),
    getLeagueEntriesByPuuid: (platform, puuid) =>
      record('league', platform, script.league ?? { kind: 'ok', data: [leagueEntry()] }, puuid),
    getMatchIdsByPuuid: (region, puuid, count) =>
      record('matchIds', region, script.matchIds ?? { kind: 'ok', data: [] }, `${puuid}:${String(count)}`),
    getMatchById: (region, matchId) =>
      record(
        'matchDetail',
        region,
        script.matchDetail?.(matchId) ?? { kind: 'ok', data: matchDto(matchId) },
        matchId,
      ),
    getMatchTimeline: () => Promise.reject(new Error('getMatchTimeline not exercised by the lookup path')),
  };

  return { client, calls, callsAt: (stage) => calls.filter((call) => call.stage === stage) };
}

/** Budget scheduler that only fires when a test calls `fire()`. */
function makeScheduler() {
  const armed: (() => void)[] = [];
  const requestedDelays: number[] = [];
  let cancelCount = 0;
  const scheduler: TimeoutScheduler = (ms, onElapsed) => {
    requestedDelays.push(ms);
    armed.push(onElapsed);
    return () => {
      cancelCount += 1;
    };
  };
  return {
    scheduler,
    requestedDelays,
    fire: () => {
      for (const onElapsed of [...armed]) {
        onElapsed();
      }
    },
    cancelCount: () => cancelCount,
  };
}

function recordingLogger() {
  const authFailures: { stage: LookupStage; routingValue: string; status: 401 | 403 }[] = [];
  const storeWriteFailures: unknown[] = [];
  const logger: LookupLogger = {
    authFailure: (info) => {
      authFailures.push(info);
    },
    storeWriteFailed: ({ reason }) => {
      storeWriteFailures.push(reason);
    },
  };
  return { logger, authFailures, storeWriteFailures };
}

interface HarnessOptions extends ClientScript {
  now?: () => number;
  cache?: CacheStore;
  matchDetailConcurrency?: number;
  matchHistoryCount?: number;
  rankHistoryStore?: import('../db/rankHistoryStore').RankHistoryStore;
  lookedUpPlayerStore?: import('../db/lookedUpPlayerStore').LookedUpPlayerStore;
}

function makeHarness(options: HarnessOptions = {}) {
  const now = options.now ?? (() => 1_000_000);
  const cache = options.cache ?? createInMemoryCacheStore({ now });
  const fakes = makeFakes(options);
  const scheduler = makeScheduler();
  const { logger, authFailures, storeWriteFailures } = recordingLogger();
  const orchestrator = createLookupOrchestrator({
    cache,
    riotApiClient: fakes.client,
    now,
    scheduleTimeout: scheduler.scheduler,
    logger,
    matchDetailConcurrency: options.matchDetailConcurrency,
    matchHistoryCount: options.matchHistoryCount,
    rankHistoryStore: options.rankHistoryStore,
    lookedUpPlayerStore: options.lookedUpPlayerStore,
  });
  return { orchestrator, cache, fakes, scheduler, authFailures, storeWriteFailures, now };
}

/** Lets the unawaited `recordLookupSideEffects` promise chain settle. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function run(
  orchestrator: {
    runLookup: (input: {
      riotId: { gameName: string; tagLine: string };
      platformOverride?: PlatformRoutingValue;
    }) => Promise<LookupResult>;
  },
  platformOverride?: PlatformRoutingValue,
): Promise<LookupResult> {
  return orchestrator.runLookup({ riotId: { gameName: GAME_NAME, tagLine: TAG_LINE }, platformOverride });
}

describe('runLookup — endpoint wiring and routing', () => {
  it('resolves the PUUID first, resolves the platform, then fetches summoner, league and match ids (Requirements 1.1-1.4, 2.1-2.3, 3.1)', async () => {
    const harness = makeHarness({ matchIds: { kind: 'ok', data: ['NA1_1', 'NA1_2'] } });

    const result = await run(harness.orchestrator);

    expect(result.kind).toBe('success');
    expect(harness.fakes.calls[0].stage).toBe('account');
    expect(harness.fakes.callsAt('account')[0]).toMatchObject({
      routingValue: 'americas',
      detail: `${GAME_NAME}#${TAG_LINE}`,
    });
    // Requirement 1.1: the Discovery_Region also hosts the region-resolution call.
    expect(harness.fakes.callsAt('regionResolution')[0]).toMatchObject({ routingValue: 'americas', detail: PUUID });
    // Requirement 1.2 / 2.2 / 2.3: platform routing for summoner and league,
    // using the platform the Region Resolver reported (na1, per the fake's default).
    expect(harness.fakes.callsAt('summoner')[0]).toMatchObject({ routingValue: 'na1', detail: PUUID });
    expect(harness.fakes.callsAt('league')[0]).toMatchObject({ routingValue: 'na1', detail: PUUID });
    // Requirement 1.3 / 3.1: regional routing derived from the platform (na1 ->
    // americas), bounded at 100.
    expect(harness.fakes.callsAt('matchIds')[0]).toMatchObject({
      routingValue: 'americas',
      detail: `${PUUID}:${String(MATCH_HISTORY_COUNT)}`,
    });
    expect(harness.fakes.callsAt('matchDetail').map((call) => call.detail)).toEqual(['NA1_1', 'NA1_2']);
    if (result.kind !== 'success') {
      return;
    }
    expect(result.report.resolvedPlatform).toBe('na1');
    expect(result.report.usedPlatformOverride).toBe(false);
  });

  it('uses the platform the Region Resolver reports, deriving the region from it (Requirement 1.2/1.3)', async () => {
    const harness = makeHarness({
      regionResolution: { kind: 'ok', data: { puuid: PUUID, game: 'lol', region: 'euw1' } },
    });

    const result = await run(harness.orchestrator);

    expect(harness.fakes.callsAt('summoner')[0].routingValue).toBe('euw1');
    expect(harness.fakes.callsAt('league')[0].routingValue).toBe('euw1');
    expect(harness.fakes.callsAt('matchIds')[0].routingValue).toBe('europe');
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }
    expect(result.report.resolvedPlatform).toBe('euw1');
  });

  it('uses platformOverride verbatim and skips the Region Resolver entirely (Requirement 2.4)', async () => {
    const harness = makeHarness();

    const result = await run(harness.orchestrator, 'euw1');

    expect(harness.fakes.callsAt('regionResolution')).toHaveLength(0);
    expect(harness.fakes.callsAt('summoner')[0].routingValue).toBe('euw1');
    expect(harness.fakes.callsAt('matchIds')[0].routingValue).toBe('europe');
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }
    expect(result.report.resolvedPlatform).toBe('euw1');
    expect(result.report.usedPlatformOverride).toBe(true);
  });

  it('returns NO_LOL_ACCOUNT and calls no platform-routed endpoint when the resolver reports no LoL account (Requirement 5.2)', async () => {
    const harness = makeHarness({ regionResolution: { kind: 'not_found' } });

    const result = await run(harness.orchestrator);

    expect(result).toEqual({ kind: 'error', code: 'NO_LOL_ACCOUNT', retriable: false });
    expect(harness.fakes.calls.map((call) => call.stage)).toEqual(['account', 'regionResolution']);
  });

  it('returns UNSUPPORTED_PLATFORM naming the platform Riot reported (Requirement 5.3)', async () => {
    const harness = makeHarness({
      regionResolution: { kind: 'ok', data: { puuid: PUUID, game: 'lol', region: 'vn2' } },
    });

    const result = await run(harness.orchestrator);

    expect(result).toEqual({ kind: 'error', code: 'UNSUPPORTED_PLATFORM', retriable: false, platform: 'vn2' });
    expect(harness.fakes.calls.map((call) => call.stage)).toEqual(['account', 'regionResolution']);
  });

  it('surfaces the resolver\u2019s own failure with no guessed fallback (Requirement 5.4)', async () => {
    const harness = makeHarness({ regionResolution: { kind: 'server_error', status: 503 } });

    const result = await run(harness.orchestrator);

    expect(result).toEqual({ kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true });
    // No summoner/league/matchIds call: the platform was never known.
    expect(harness.fakes.calls.map((call) => call.stage)).toEqual(['account', 'regionResolution']);
  });

  it('arms the budget with the Requirement 11.2 duration and always disarms it', async () => {
    const harness = makeHarness();
    await run(harness.orchestrator);
    expect(harness.scheduler.requestedDelays).toEqual([FRESH_PATH_BUDGET_MS]);
    expect(harness.scheduler.cancelCount()).toBe(1);
  });
});

describe('runLookup — account not found (Requirements 2.4, 9.2)', () => {
  it('halts the pipeline and echoes the submitted Riot ID', async () => {
    const harness = makeHarness({ account: { kind: 'not_found' } });

    const result = await run(harness.orchestrator);

    expect(result).toEqual({ kind: 'not_found', gameName: GAME_NAME, tagLine: TAG_LINE });
    // No Summoner-V4, League-V4 or Match-V5 call was issued.
    expect(harness.fakes.calls.map((call) => call.stage)).toEqual(['account']);
  });

  it('persists nothing for the session', async () => {
    const now = () => 5_000;
    const cache = createInMemoryCacheStore({ now });
    const harness = makeHarness({ account: { kind: 'not_found' }, now, cache });

    await run(harness.orchestrator);

    expect(cache.size).toBe(0);
  });
});

describe('runLookup — Requirement 9 error mapping', () => {
  const cases: {
    name: string;
    script: ClientScript;
    expected: LookupResult;
  }[] = [
    {
      name: '5xx on account is a retriable RIOT_UNAVAILABLE (9.3)',
      script: { account: { kind: 'server_error', status: 503 } },
      expected: { kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true },
    },
    {
      name: 'timeout is TIMEOUT (9.4)',
      script: { account: { kind: 'timeout' } },
      expected: { kind: 'error', code: 'TIMEOUT', retriable: false },
    },
    {
      name: '401 is a generic AUTH_FAILURE (9.5)',
      script: { account: { kind: 'auth_error', status: 401 } },
      expected: { kind: 'error', code: 'AUTH_FAILURE', retriable: false },
    },
    {
      name: '429 after retries is RATE_LIMITED (9.8)',
      script: { account: { kind: 'rate_limited', retryAfterSeconds: 7 } },
      expected: { kind: 'error', code: 'RATE_LIMITED', retriable: true },
    },
    {
      name: 'a transport failure is NETWORK_ERROR (9.9)',
      script: { account: { kind: 'network_error' } },
      expected: { kind: 'error', code: 'NETWORK_ERROR', retriable: true },
    },
    {
      name: 'a league failure after PUUID resolution is RIOT_UNAVAILABLE (2.7)',
      script: { league: { kind: 'server_error', status: 502 } },
      expected: { kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true },
    },
    {
      name: 'a match-ids failure is MATCH_HISTORY_UNAVAILABLE (3.6)',
      script: { matchIds: { kind: 'server_error', status: 504 } },
      expected: { kind: 'error', code: 'MATCH_HISTORY_UNAVAILABLE', retriable: true },
    },
    {
      // League-V4 returns 200 with [] for an unranked player, so a 404 there is an
      // unreadable response rather than evidence about the platform.
      name: 'a League-V4 404 stays RIOT_UNAVAILABLE',
      script: { league: { kind: 'not_found' } },
      expected: { kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: false },
    },
    {
      name: 'a cause-specific code wins over the match-history code',
      script: { matchIds: { kind: 'auth_error', status: 403 } },
      expected: { kind: 'error', code: 'AUTH_FAILURE', retriable: false },
    },
  ];

  for (const { name, script, expected } of cases) {
    it(name, async () => {
      const harness = makeHarness(script);
      await expect(run(harness.orchestrator)).resolves.toEqual(expected);
    });
  }

  it('reports the first failure in requirement order (league before match-ids) when both fail at once, and Summoner-V4 never enters the race (Requirement 4.5)', async () => {
    const harness = makeHarness({
      summoner: { kind: 'server_error', status: 500 }, // must not affect the outcome at all
      league: { kind: 'network_error' },
      matchIds: { kind: 'timeout' },
    });

    await expect(run(harness.orchestrator)).resolves.toEqual({
      kind: 'error',
      code: 'NETWORK_ERROR',
      retriable: true,
    });
  });

  it('completes successfully with null summonerLevel/profileIconId when the Summoner-V4 enrichment call fails for any reason (Requirement 4.1, 4.2, 4.4, 4.5)', async () => {
    const harness = makeHarness({
      matchIds: { kind: 'ok', data: [] },
      summoner: { kind: 'not_found' },
    });

    const result = await run(harness.orchestrator);

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }
    expect(result.report.summonerLevel).toBeNull();
    expect(result.report.profileIconId).toBeNull();
  });

  it('logs every 401/403 server-side without any credential material, including from the enrichment call (Requirement 9.5)', async () => {
    const harness = makeHarness({
      summoner: { kind: 'auth_error', status: 401 },
      league: { kind: 'auth_error', status: 403 },
    });

    await run(harness.orchestrator);

    expect(harness.authFailures).toEqual([
      { stage: 'summoner', routingValue: 'na1', status: 401 },
      { stage: 'league', routingValue: 'na1', status: 403 },
    ]);
  });

  it('treats a 200 with no PUUID as an unreadable response', async () => {
    const harness = makeHarness({ account: { kind: 'ok', data: account({ puuid: '' }) } });

    await expect(run(harness.orchestrator)).resolves.toEqual({
      kind: 'error',
      code: 'RIOT_UNAVAILABLE',
      retriable: true,
    });
    expect(harness.fakes.calls.map((call) => call.stage)).toEqual(['account']);
  });
});

describe('runLookup — match history assembly (Requirements 3.3, 3.4, 3.5)', () => {
  it('excludes matches that fail to fetch and keeps processing the rest', async () => {
    const matchIds = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
    const harness = makeHarness({
      matchIds: { kind: 'ok', data: matchIds },
      matchDetail: (matchId) =>
        matchId === 'm2'
          ? { kind: 'timeout' }
          : matchId === 'm4'
            ? { kind: 'rate_limited' }
            : { kind: 'ok', data: matchDto(matchId) },
      matchDetailConcurrency: 2,
    });

    const result = await run(harness.orchestrator);

    expect(result.kind).toBe('success');
    // Every id was attempted despite the earlier failures.
    expect(harness.fakes.callsAt('matchDetail').map((call) => call.detail)).toEqual(matchIds);
    if (result.kind !== 'success') {
      return;
    }
    expect(result.report.stats.topChampions[0].gamesPlayed).toBe(4);
    // Fewer than 5 included matches, so the limited-data notice is on.
    expect(result.report.limitedDataNotice).toBe(true);
  });

  it('excludes disallowed (non-laneless) queue types from stats and from the limited-data count, and excludes them from recentMatches too', async () => {
    const harness = makeHarness({
      matchIds: { kind: 'ok', data: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'] },
      matchDetail: (matchId) => ({
        kind: 'ok',
        // Clash for two of the six — genuinely excluded from everything,
        // unlike ARAM/ARAM Mayhem (`match-detail-tabs` Requirement 11), which
        // is covered separately below.
        data: matchDto(matchId, { queueId: matchId === 'm1' || matchId === 'm2' ? 700 : 400 }),
      }),
    });

    const result = await run(harness.orchestrator);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }
    expect(result.report.stats.topChampions[0].gamesPlayed).toBe(4);
    expect(result.report.limitedDataNotice).toBe(true);
    expect(result.report.recentMatches).toHaveLength(4);
  });

  it('admits ARAM and ARAM Mayhem to recentMatches, but excludes them from stats and the limited-data count (`match-detail-tabs` Requirement 11)', async () => {
    const harness = makeHarness({
      matchIds: { kind: 'ok', data: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'] },
      matchDetail: (matchId) => ({
        kind: 'ok',
        data: matchDto(matchId, { queueId: matchId === 'm1' ? 450 : matchId === 'm2' ? 2400 : 400 }),
      }),
    });

    const result = await run(harness.orchestrator);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }
    // Stats and the limited-data count only ever see the four role-relative matches.
    expect(result.report.stats.topChampions[0].gamesPlayed).toBe(4);
    expect(result.report.limitedDataNotice).toBe(true);
    // recentMatches admits all six — the two laneless matches compete for a slot
    // on equal footing, per computeRecentMatches's merge.
    expect(result.report.recentMatches).toHaveLength(6);
    const aram = result.report.recentMatches.find((match) => match.matchId === 'm1');
    const mayhem = result.report.recentMatches.find((match) => match.matchId === 'm2');
    expect(aram?.queueType).toBe('aram');
    expect(mayhem?.queueType).toBe('aram mayhem');
    // No lane, so no role and no Enemy_Laner — for both.
    expect(aram?.role).toBe('');
    expect(aram?.opponent).toBeNull();
    expect(mayhem?.role).toBe('');
    expect(mayhem?.opponent).toBeNull();
    // Both still carry all captured participants, with isEnemyLaner false throughout.
    expect(aram?.participants).toHaveLength(2);
    expect(aram?.participants.every((participant) => !participant.isEnemyLaner)).toBe(true);
  });

  it('clears the limited-data notice at 5 included matches', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];
    const harness = makeHarness({ matchIds: { kind: 'ok', data: ids } });

    const result = await run(harness.orchestrator);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }
    expect(result.report.limitedDataNotice).toBe(false);
  });

  it('never issues more than the match-history cap, even for an oversized cached id list', async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `m${String(index)}`);
    const harness = makeHarness({ matchIds: { kind: 'ok', data: ids }, matchHistoryCount: 20 });

    await run(harness.orchestrator);

    expect(harness.fakes.callsAt('matchDetail')).toHaveLength(20);
  });

  it('ignores malformed match ids in the list', async () => {
    const harness = makeHarness({
      matchIds: { kind: 'ok', data: ['m1', '', null as unknown as string, 'm2'] },
    });

    await run(harness.orchestrator);

    expect(harness.fakes.callsAt('matchDetail').map((call) => call.detail)).toEqual(['m1', 'm2']);
  });
});

describe('runLookup — report contents', () => {
  it('renders stats, fun facts, recommendations and the 7.3 average duration', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
    const harness = makeHarness({
      matchIds: { kind: 'ok', data: ids },
      matchDetail: (matchId) => {
        const index = ids.indexOf(matchId);
        return {
          kind: 'ok',
          data: matchDto(matchId, {
            championName: index < 4 ? 'Ahri' : 'Lux',
            role: index < 5 ? 'MIDDLE' : 'TOP',
            win: index % 2 === 0,
            durationSeconds: 1_800,
            startTimestamp: 1_700_000_000_000 + index * 3_600_000,
          }),
        };
      },
    });

    const result = await run(harness.orchestrator);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }
    const report = result.report;

    expect(report.riotId).toEqual({ gameName: GAME_NAME, tagLine: TAG_LINE });
    expect(report.puuid).toBe(PUUID);
    expect(report.summonerLevel).toBe(412);
    expect(report.profileIconId).toBe(29);
    // Requirement 6.1/6.2: ranked standing keyed by the queue types League-V4 returned.
    expect(report.stats.rankedByQueue).toEqual({
      RANKED_SOLO_5x5: { tier: 'PLATINUM', division: 'IV', winRatePercent: 60, leaguePoints: 51 },
    });
    expect(report.stats.topChampions.map((champion) => champion.championName)).toEqual(['Ahri', 'Lux']);
    expect(report.stats.mostPlayedRole).toBe('MIDDLE');
    // Requirement 7.3: 1800s per match is 30 minutes.
    expect(report.averageMatchDurationMinutes).toBe(30);
    // Requirement 7.4: four eligible categories with 6 matches.
    expect(report.funFacts.map((fact) => fact.category)).toEqual([
      'rolePreference',
      'championLoyalty',
      'timeOfDay',
      'streak',
    ]);
    expect(report.limitedDataNotice).toBe(false);
    expect(report.partialDataWarning).toBe(false);
    for (const recommendation of report.recommendations) {
      expect(recommendation.metricName).not.toBe('');
      expect(Number.isFinite(recommendation.metricValue)).toBe(true);
    }
  });

  it('renders an empty ranked entry list as a valid unranked state (Requirements 2.8, 6.1)', async () => {
    const harness = makeHarness({ league: { kind: 'ok', data: [] } });

    const result = await run(harness.orchestrator);

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }
    expect(result.report.stats.rankedByQueue).toEqual({});
  });

  it('assembles per-queue stats/role-performance; statsByQueue.all stays identical to stats (profile-sidebar Req 7.1/8.1)', async () => {
    // 4 matches: 2 solo (Ahri, both wins), 1 flex (Zed, loss), 1 normal (Lux, win).
    const harness = makeHarness({
      matchIds: { kind: 'ok', data: ['s1', 's2', 'f1', 'n1'] },
      matchDetail: (matchId) => {
        const spec: Record<string, { queueId: number; champ: string; role: string; win: boolean }> = {
          s1: { queueId: 420, champ: 'Ahri', role: 'MIDDLE', win: true },
          s2: { queueId: 420, champ: 'Ahri', role: 'MIDDLE', win: true },
          f1: { queueId: 440, champ: 'Zed', role: 'MIDDLE', win: false },
          n1: { queueId: 400, champ: 'Lux', role: 'BOTTOM', win: true },
        };
        const s = spec[matchId];
        return { kind: 'ok', data: matchDto(matchId, { queueId: s.queueId, championName: s.champ, role: s.role, win: s.win }) };
      },
    });

    const result = await run(harness.orchestrator);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }
    const { report } = result;

    // Additive, not a rename.
    expect(report.statsByQueue.all).toEqual(report.stats);
    expect(Object.keys(report.statsByQueue).sort()).toEqual(['all', 'normal', 'ranked flex', 'ranked solo/duo']);

    // 'all' sees every champion; the solo slice sees only Ahri.
    expect(report.statsByQueue.all.topChampions.map((c) => c.championName).sort()).toEqual(['Ahri', 'Lux', 'Zed']);
    expect(report.statsByQueue['ranked solo/duo'].topChampions.map((c) => c.championName)).toEqual(['Ahri']);
    expect(report.statsByQueue['ranked solo/duo'].topChampions[0].gamesPlayed).toBe(2);

    // Role performance is scoped the same way.
    expect(report.rolePerformanceByQueue.all).toEqual([
      { role: 'MIDDLE', gamesPlayed: 3, winRatePercent: 67 },
      { role: 'BOTTOM', gamesPlayed: 1, winRatePercent: 100 },
    ]);
    expect(report.rolePerformanceByQueue['ranked solo/duo']).toEqual([
      { role: 'MIDDLE', gamesPlayed: 2, winRatePercent: 100 },
    ]);
    expect(report.rolePerformanceByQueue['ranked flex']).toEqual([
      { role: 'MIDDLE', gamesPlayed: 1, winRatePercent: 0 },
    ]);
  });

  it('prefers the canonical Riot ID casing returned by Account-V1', async () => {
    const harness = makeHarness({
      account: { kind: 'ok', data: account({ gameName: 'DoFFy', tagLine: 'SMILE' }) },
    });

    const result = await run(harness.orchestrator);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }
    expect(result.report.riotId).toEqual({ gameName: 'DoFFy', tagLine: 'SMILE' });
  });

  it('reports profileIconId 0 as 0, never conflating a real icon with absence', async () => {
    const harness = makeHarness({
      summoner: { kind: 'ok', data: { puuid: PUUID, id: 'sid', summonerLevel: 30, profileIconId: 0 } },
    });

    const result = await run(harness.orchestrator);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }
    // Data Dragon serves profileicon/0.png with a 200: zero is a real icon.
    expect(result.report.profileIconId).toBe(0);
  });

  it('reports profileIconId as null when the summoner payload carries no usable id', async () => {
    const malformed = { puuid: PUUID, id: 'sid', summonerLevel: 30 } as unknown as SummonerDto;
    const harness = makeHarness({ summoner: { kind: 'ok', data: malformed } });

    const result = await run(harness.orchestrator);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }
    // Absent must be null — the old finiteOrZero coercion rendered icon 0 here.
    expect(result.report.profileIconId).toBeNull();
    // summonerLevel keeps its existing finiteOrZero handling (and here is simply
    // present); only profileIconId changes encoding, because only there does zero
    // collide with a real value.
    expect(result.report.summonerLevel).toBe(30);
  });
});

describe('runLookup — last-updated timestamp (Requirements 11.4, 11.5)', () => {
  it('is null when every component was retrieved for the first time', async () => {
    const harness = makeHarness();

    const result = await run(harness.orchestrator);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }
    expect(result.report.lastUpdated).toBeNull();
  });

  it('reports the oldest component used once data comes from the cache', async () => {
    let clock = 1_000_000;
    const cache = createInMemoryCacheStore({ now: () => clock });
    const first = makeHarness({ now: () => clock, cache });
    await run(first.orchestrator);

    // Advance past the league TTL only, so league refreshes and the rest is served
    // from the cache written above.
    clock += (TTL_BY_ENDPOINT.league as number) + 1;
    const second = makeHarness({ now: () => clock, cache });
    const result = await run(second.orchestrator);

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }
    expect(result.report.lastUpdated).toBe(new Date(1_000_000).toISOString());
    // League was refreshed; account and region resolution were cached and not
    // called at all. Summoner-V4 is an Enrichment_Call that is never cached
    // (design.md), so it is fetched fresh on every lookup regardless — its
    // outcome does not participate in `lastUpdated` at all (decision 7 amended).
    expect(second.fakes.callsAt('league')).toHaveLength(1);
    expect(second.fakes.callsAt('account')).toHaveLength(0);
    expect(second.fakes.callsAt('regionResolution')).toHaveLength(0);
    expect(second.fakes.callsAt('summoner')).toHaveLength(1);
  });

  it('excludes indefinitely-cached match details from the calculation', () => {
    // Requirement 10.4 keeps match details forever, so their retrieval time must
    // not drag the profile's reported freshness backwards (decision 7).
    expect(lastUpdatedOf([{ fromCache: true, retrievedAt: 5_000 }])).toBe(new Date(5_000).toISOString());
    expect(
      lastUpdatedOf([
        { fromCache: false, retrievedAt: 9_000 },
        { fromCache: true, retrievedAt: 7_000 },
      ]),
    ).toBe(new Date(7_000).toISOString());
    expect(lastUpdatedOf([{ fromCache: false, retrievedAt: 9_000 }])).toBeNull();
  });
});

describe('runLookup — caching behavior (Requirements 10.5-10.7)', () => {
  it('serves a repeated lookup entirely from cache except the Summoner-V4 enrichment call', async () => {
    const clock = 2_000_000;
    const cache = createInMemoryCacheStore({ now: () => clock });
    const first = makeHarness({ now: () => clock, cache, matchIds: { kind: 'ok', data: ['m1', 'm2'] } });
    await run(first.orchestrator);
    expect(first.fakes.calls.length).toBeGreaterThan(0);

    const second = makeHarness({ now: () => clock, cache, matchIds: { kind: 'ok', data: ['m1', 'm2'] } });
    const result = await run(second.orchestrator);

    expect(result.kind).toBe('success');
    // Summoner-V4 is an Enrichment_Call that is deliberately never cached
    // (design.md's rate-limiting table), so it is the one call every lookup
    // still makes even when everything else is served from cache.
    expect(second.fakes.calls.map((call) => call.stage)).toEqual(['summoner']);
  });

  it('never caches the Summoner-V4 enrichment call, success or failure', async () => {
    const clock = 3_000_000;
    const cache = createInMemoryCacheStore({ now: () => clock });
    const harness = makeHarness({ now: () => clock, cache, summoner: { kind: 'server_error', status: 500 } });

    await run(harness.orchestrator);

    const stored = await cache.get<SummonerDto>({
      endpoint: 'summoner',
      routingValue: 'na1' as PlatformRoutingValue,
      params: { puuid: PUUID },
    });
    expect(stored).toBeUndefined();
  });
});

describe('runLookup — Requirement 11.3 fallback to last-known cache', () => {
  /** Seeds a complete, stale-but-usable snapshot for the PUUID. */
  async function seedSnapshot(cache: InMemoryCacheStore, matchIds: string[]): Promise<void> {
    const keys: { key: CacheKey; value: unknown; ttl: number | 'infinite' }[] = [
      {
        key: { endpoint: 'account', routingValue: 'americas', params: { gameName: GAME_NAME, tagLine: TAG_LINE } },
        value: account(),
        ttl: TTL_BY_ENDPOINT.account,
      },
      {
        key: { endpoint: 'accountRegion', routingValue: 'americas', params: { puuid: PUUID, game: 'lol' } },
        value: { puuid: PUUID, game: 'lol', region: 'na1' },
        ttl: TTL_BY_ENDPOINT.accountRegion,
      },
      {
        key: { endpoint: 'league', routingValue: 'na1', params: { puuid: PUUID } },
        value: [leagueEntry({ tier: 'SILVER', rank: 'I', wins: 10, losses: 10 })],
        ttl: TTL_BY_ENDPOINT.league,
      },
      {
        key: { endpoint: 'matchIds', routingValue: 'americas', params: { puuid: PUUID } },
        value: matchIds,
        ttl: TTL_BY_ENDPOINT.matchIds,
      },
    ];
    for (const { key, value, ttl } of keys) {
      await cache.set(key, value, ttl);
    }
    for (const matchId of matchIds) {
      await cache.set(
        { endpoint: 'matchDetail', routingValue: 'americas', params: { matchId } },
        matchDto(matchId, { championName: 'Zed' }),
        TTL_BY_ENDPOINT.matchDetail,
      );
    }
  }

  it('serves the cached snapshot with partialDataWarning when a required call fails', async () => {
    let clock = 10_000;
    const cache = createInMemoryCacheStore({ now: () => clock });
    await seedSnapshot(cache, ['m1', 'm2']);

    // Age everything past its TTL so the pipeline must refresh, then fail it.
    clock += (TTL_BY_ENDPOINT.summoner as number) + 1;
    const harness = makeHarness({
      now: () => clock,
      cache,
      league: { kind: 'server_error', status: 503 },
      matchIds: { kind: 'ok', data: ['m1', 'm2'] },
    });

    const result = await run(harness.orchestrator);

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }
    expect(result.report.partialDataWarning).toBe(true);
    // Enrichment is never cached (design.md), so a fallback report can never
    // have summoner data, regardless of how this data was seeded elsewhere.
    expect(result.report.summonerLevel).toBeNull();
    expect(result.report.stats.topChampions[0].championName).toBe('Zed');
    expect(result.report.lastUpdated).toBe(new Date(10_000).toISOString());
  });

  it('reports an error instead when the cached snapshot is incomplete (Requirement 2.7)', async () => {
    const clock = 10_000;
    const cache = createInMemoryCacheStore({ now: () => clock });
    await seedSnapshot(cache, ['m1']);
    // Remove the whole cached snapshot for this PUUID, leaving nothing for the
    // fallback to read.
    await cache.deleteByPuuid(PUUID);

    const harness = makeHarness({ now: () => clock, cache, league: { kind: 'server_error', status: 503 } });
    await expect(run(harness.orchestrator)).resolves.toEqual({
      kind: 'error',
      code: 'RIOT_UNAVAILABLE',
      retriable: true,
    });
  });

  it('stops waiting when the 15s budget expires and serves the cache instead', async () => {
    const clock = 50_000;
    const cache = createInMemoryCacheStore({ now: () => clock });
    const fired = { value: false };

    const harness = makeHarness({
      now: () => clock,
      cache,
      matchIds: { kind: 'ok', data: ['m1', 'm2', 'm3', 'm4'] },
      matchDetailConcurrency: 1,
      onCall: (stage) => {
        // Fire the budget once the fan-out has started, so the PUUID and the
        // profile-state components are already cached.
        if (stage === 'matchDetail' && !fired.value) {
          fired.value = true;
        }
      },
    });

    // The scheduler is fired from outside the client, right after the first
    // match-detail request is observed, by polling the recorded calls.
    const lookup = run(harness.orchestrator);
    await Promise.resolve();
    const waitForFanOut = async () => {
      for (let attempt = 0; attempt < 50 && harness.fakes.callsAt('matchDetail').length === 0; attempt += 1) {
        await Promise.resolve();
      }
    };
    await waitForFanOut();
    harness.scheduler.fire();

    const result = await lookup;

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }
    expect(result.report.partialDataWarning).toBe(true);
    // The fan-out stopped early rather than working through all four ids.
    expect(harness.fakes.callsAt('matchDetail').length).toBeLessThan(4);
  });

  it('reports TIMEOUT when the budget expires before the PUUID is known', async () => {
    const clock = 60_000;
    const cache = createInMemoryCacheStore({ now: () => clock });
    const fakes = makeFakes({});
    const orchestrator = createLookupOrchestrator({
      cache,
      riotApiClient: fakes.client,
      now: () => clock,
      // Fires the moment the budget is armed, before the account call resolves.
      scheduleTimeout: (_ms, onElapsed) => {
        onElapsed();
        return () => undefined;
      },
      logger: recordingLogger().logger,
    });

    await expect(run(orchestrator)).resolves.toEqual({ kind: 'error', code: 'TIMEOUT', retriable: false });
  });
});

describe('runLookup — Persistent_Store side effects (specs/database/ Requirement 2/3/4)', () => {
  it('records a Ranked Solo/Duo snapshot and remembers the player on a fresh success', async () => {
    const rankHistoryStore = createInMemoryRankHistoryStore();
    const lookedUpPlayerStore = createInMemoryLookedUpPlayerStore();
    const now = () => 1_726_000_000_000;
    const harness = makeHarness({ now, rankHistoryStore, lookedUpPlayerStore });

    const result = await run(harness.orchestrator);
    await flushMicrotasks();

    expect(result.kind).toBe('success');
    const history = await rankHistoryStore.history(PUUID, 'RANKED_SOLO_5x5');
    expect(history).toEqual([
      {
        puuid: PUUID,
        queueType: 'RANKED_SOLO_5x5',
        tier: 'PLATINUM',
        division: 'IV',
        leaguePoints: 51,
        observedAt: now(),
      },
    ]);
    const remembered = await lookedUpPlayerStore.searchByNamePrefix(GAME_NAME, 10);
    expect(remembered).toEqual([
      {
        puuid: PUUID,
        gameName: GAME_NAME,
        tagLine: TAG_LINE,
        profileIconId: 29,
        region: 'na1',
        lastLookedUpAt: now(),
      },
    ]);
    expect(harness.storeWriteFailures).toEqual([]);
  });

  it('remembers the player but records no snapshot for an unranked lookup', async () => {
    const rankHistoryStore = createInMemoryRankHistoryStore();
    const lookedUpPlayerStore = createInMemoryLookedUpPlayerStore();
    const harness = makeHarness({
      league: { kind: 'ok', data: [] }, // unranked
      rankHistoryStore,
      lookedUpPlayerStore,
    });

    await run(harness.orchestrator);
    await flushMicrotasks();

    expect(await rankHistoryStore.history(PUUID, 'RANKED_SOLO_5x5')).toEqual([]);
    expect(await lookedUpPlayerStore.searchByNamePrefix(GAME_NAME, 10)).toHaveLength(1);
  });

  it('touches neither store on a not_found result', async () => {
    const rankHistoryStore = createInMemoryRankHistoryStore();
    const lookedUpPlayerStore = createInMemoryLookedUpPlayerStore();
    const harness = makeHarness({
      account: { kind: 'not_found' },
      rankHistoryStore,
      lookedUpPlayerStore,
    });

    const result = await run(harness.orchestrator);
    await flushMicrotasks();

    expect(result.kind).toBe('not_found');
    expect(rankHistoryStore.size).toBe(0);
    expect(lookedUpPlayerStore.size).toBe(0);
  });

  it('touches neither store on an error result', async () => {
    const rankHistoryStore = createInMemoryRankHistoryStore();
    const lookedUpPlayerStore = createInMemoryLookedUpPlayerStore();
    const harness = makeHarness({
      league: { kind: 'network_error' },
      rankHistoryStore,
      lookedUpPlayerStore,
    });

    const result = await run(harness.orchestrator);
    await flushMicrotasks();

    expect(result.kind).toBe('error');
    expect(rankHistoryStore.size).toBe(0);
    expect(lookedUpPlayerStore.size).toBe(0);
  });

  it('does not record from the Requirement 11.3 stale-cache fallback', async () => {
    let clock = 10_000;
    const rankHistoryStore = createInMemoryRankHistoryStore();
    const lookedUpPlayerStore = createInMemoryLookedUpPlayerStore();
    const cache = createInMemoryCacheStore({ now: () => clock });

    // Seed a complete, still-readable snapshot for the PUUID.
    await cache.set(
      { endpoint: 'account', routingValue: 'americas', params: { gameName: GAME_NAME, tagLine: TAG_LINE } },
      account(),
      TTL_BY_ENDPOINT.account,
    );
    await cache.set(
      { endpoint: 'accountRegion', routingValue: 'americas', params: { puuid: PUUID, game: 'lol' } },
      { puuid: PUUID, game: 'lol', region: 'na1' },
      TTL_BY_ENDPOINT.accountRegion,
    );
    await cache.set(
      { endpoint: 'league', routingValue: 'na1', params: { puuid: PUUID } },
      [leagueEntry()],
      TTL_BY_ENDPOINT.league,
    );
    await cache.set(
      { endpoint: 'matchIds', routingValue: 'americas', params: { puuid: PUUID } },
      ['m1'],
      TTL_BY_ENDPOINT.matchIds,
    );
    await cache.set(
      { endpoint: 'matchDetail', routingValue: 'americas', params: { matchId: 'm1' } },
      matchDto('m1'),
      TTL_BY_ENDPOINT.matchDetail,
    );

    // Age past the league TTL so the pipeline must refresh it — then fail that
    // refresh, forcing the Requirement 11.3 fallback onto the seeded snapshot.
    clock += (TTL_BY_ENDPOINT.league as number) + 1;
    const harness = makeHarness({
      now: () => clock,
      cache,
      league: { kind: 'server_error', status: 503 },
      rankHistoryStore,
      lookedUpPlayerStore,
    });

    const result = await run(harness.orchestrator);
    await flushMicrotasks();

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.report.partialDataWarning).toBe(true);
    }
    expect(rankHistoryStore.size).toBe(0);
    expect(lookedUpPlayerStore.size).toBe(0);
  });

  it('a throwing store never fails the lookup and never escapes as a rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const throwing = (): never => {
        throw new Error('store is on fire');
      };
      const rankHistoryStore: RankHistoryStore = {
        record: () => Promise.reject(new Error('record failed')),
        history: () => Promise.resolve([]),
        deleteByPuuid: () => Promise.resolve(0),
      };
      const lookedUpPlayerStore: LookedUpPlayerStore = {
        remember: throwing,
        searchByNamePrefix: () => Promise.resolve([]),
        deleteByPuuid: () => Promise.resolve(0),
      };
      const harness = makeHarness({ rankHistoryStore, lookedUpPlayerStore });

      const result = await run(harness.orchestrator);
      await flushMicrotasks();

      expect(result.kind).toBe('success');
      expect(harness.storeWriteFailures.length).toBeGreaterThan(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('returns the success result without waiting for a slow store write', async () => {
    let resolveWrite: (() => void) | undefined;
    const rankHistoryStore: RankHistoryStore = {
      record: () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
      history: () => Promise.resolve([]),
      deleteByPuuid: () => Promise.resolve(0),
    };
    const harness = makeHarness({ rankHistoryStore });

    const result = await run(harness.orchestrator);

    // The write is still pending here; the lookup did not block on it.
    expect(result.kind).toBe('success');
    expect(resolveWrite).toBeTypeOf('function');
    resolveWrite?.();
  });
});
