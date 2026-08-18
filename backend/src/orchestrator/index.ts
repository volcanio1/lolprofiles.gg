/**
 * Lookup Orchestrator.
 *
 * The coordination layer Requirements 2, 3, 9, 10 and 11 are really specifying:
 * it turns a validated Riot ID plus a region into a `ProfileReport`, or into a
 * typed failure. It owns cache-or-fetch sequencing, the queue-type filter, the
 * Insight Engine invocation, the Requirement 9 error mapping, and the 15s
 * fresh-path budget with its fall back to last-known cache.
 *
 * Every collaborator is injected — cache, Riot API client, clock, budget
 * scheduler, logger — so no test needs a network, a real timer or a credential,
 * matching every other module in this build.
 *
 * Implements:
 *  - 2.1: Account-V1 resolves the PUUID first, using the regional routing value.
 *  - 2.2 / 2.3: Summoner-V4 and League-V4 by PUUID, using the PLATFORM routing
 *    value chosen by the Region Router (2.5 / 5.4).
 *  - 2.4: an Account-V1 not-found halts the pipeline before any Summoner-V4,
 *    League-V4 or Match-V5 call, and leaves nothing behind.
 *  - 2.7: a post-PUUID failure never yields a report synthesized from partial
 *    data (see decision 4 for how this composes with 11.3).
 *  - 2.8: zero ranked entries is a valid unranked state, never a failure.
 *  - 3.1: up to `MATCH_HISTORY_COUNT` recent match ids.
 *  - 3.2 / 3.3: each match detail is fetched; an individual failure excludes that
 *    match and processing continues with the rest.
 *  - 3.4 / 3.5: disallowed queue types are excluded, and the limited-data notice
 *    is driven by the INCLUDED count.
 *  - 3.6: a match-ids failure stops the pipeline for that PUUID.
 *  - 9.2-9.5, 9.8, 9.9: Riot outcomes map onto the declared `ErrorCode` set, and
 *    401/403 is logged server-side without any key material.
 *  - 10.5-10.8: delegated wholesale to `cacheOrFetch`.
 *  - 11.3: a fresh path that exceeds the 15s budget, or fails, falls back to the
 *    most recent complete cached snapshot with `partialDataWarning: true`.
 *  - 11.4 / 11.5: `lastUpdated` reports the age of the data actually used, and is
 *    `null` on a first retrieval.
 *  - 7.3: the report carries the player's average match duration in minutes.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. `ProfileReport` GAINS `averageMatchDurationMinutes`. Requirement 7.3
 *    requires the average match duration to be DISPLAYED, but design.md's
 *    `ProfileReport` had no field for it and `FunFact['category']` is a closed
 *    four-value union that does not include duration, so task 10.1 had to export
 *    `averageMatchDurationMinutesOf` with no display target and recorded the gap
 *    as an open item for this task. The field is added here and design.md is
 *    amended to match. Adding it to `ProfileReport` rather than to `ProfileStats`
 *    keeps `ProfileStats` exactly as Requirement 6 defines it — duration is a 7.3
 *    fun-facts-section value, not one of Requirement 6's stats.
 *
 * 2. THE ERROR CODE IS CHOSEN BY THE FAILURE CAUSE, WITH ONE STAGE-SPECIFIC
 *    OVERRIDE. Requirements 9.4, 9.5, 9.8 and 9.9 each mandate a specific
 *    user-facing message for a specific CAUSE (timeout, rejected key, rate limit,
 *    no HTTP response) regardless of which endpoint hit it, so the cause wins.
 *    Requirement 3.6 mandates a match-history-specific message when
 *    match-ids-by-puuid fails, so the residual "Riot returned an error we cannot
 *    read" case is reported as `MATCH_HISTORY_UNAVAILABLE` at that stage and as
 *    `RIOT_UNAVAILABLE` everywhere else. The full table is in `errorFor`.
 *
 * 3. A DOWNSTREAM 404 IS `RIOT_UNAVAILABLE`, NEVER `PLAYER_NOT_FOUND`.
 *    `PLAYER_NOT_FOUND` is reserved for the Account-V1 404 of Requirements 2.4 /
 *    9.2, which is the only case where the player genuinely does not exist. A 404
 *    from Summoner-V4 or League-V4 for a PUUID that Account-V1 just resolved is a
 *    response we cannot read as data, so it takes the same retriable path the
 *    Riot API Client already assigns to unreadable responses (its decision 3).
 *    Reporting "player not found" for a player we just found would be false.
 *
 * 4. HOW REQUIREMENT 2.7 AND REQUIREMENT 11.3 COMPOSE. Read in isolation, 2.7
 *    forbids displaying a report containing "partial or stale data" after a
 *    post-PUUID failure, while 11.3 requires displaying a report built from "the
 *    most recent available Cache_Store data" with a staleness indication when a
 *    required call fails or overruns. design.md already adjudicates this in its
 *    sequence-flow section: the orchestrator "does not synthesize a partial
 *    report: it either falls back to the most recent fully-cached report with a
 *    staleness indicator (Requirement 11.3), or if no prior cached report exists,
 *    returns an error result (Requirement 2.7 / 3.6)."
 *
 *    That is implemented literally. The prohibition 2.7 expresses is against
 *    SYNTHESIS — assembling a report whose components are missing, or silently
 *    mixing fresh data with stale data. The fallback never does that: it is
 *    attempted only when the cache holds EVERY required component (summoner,
 *    league and match-ids for the resolved PUUID), the report it produces is
 *    complete, `partialDataWarning` is `true`, and `lastUpdated` reports the
 *    OLDEST component's retrieval time so the age shown is never flattering. When
 *    any component is missing there is no report at all, only an error — which is
 *    2.7's outcome.
 *
 * 5. THE 15s BUDGET IS A RACE, NOT A POLL. Requirement 11.3 says to "stop
 *    waiting" on a call that overruns, so the pipeline is raced against an
 *    injected budget timer rather than having its elapsed time inspected between
 *    phases. Polling could only notice an overrun after the current Riot call
 *    returned, and each of those is allowed 10s of its own (Requirement 2.6), so a
 *    poll could overshoot the budget by a full call. When the timer fires, an
 *    abort flag also stops the match-detail fan-out from issuing further requests,
 *    so abandoning the wait does not leave work hammering Riot in the background;
 *    calls already in flight are bounded by the client's own 10s timeout, and
 *    their only side effect is populating the cache.
 *
 * 6. THE BUDGET COVERS THE WHOLE LOOKUP, AND A FULLY CACHED LOOKUP NEVER TRIPS
 *    IT. The timer is armed once per `runLookup` and cancelled on every exit path,
 *    including throws, so no lookup leaves a pending timer holding the event loop
 *    open. A lookup served entirely from cache performs no I/O at all and settles
 *    long before the timer, which is what Requirement 11.1's cached-path target
 *    depends on.
 *
 * 7. `lastUpdated` IS THE OLDEST PROFILE-STATE COMPONENT, AND `null` ONLY ON A
 *    FIRST RETRIEVAL. Requirement 11.4 asks for "the last-updated timestamp of
 *    the data used", and the data used has several timestamps, so the report is
 *    only as up to date as its stalest component: the minimum is the only honest
 *    single value. The four components counted are account, summoner, league and
 *    match-ids — the refreshable ones. Match details are deliberately excluded
 *    from the calculation: they are cached indefinitely because completed matches
 *    are immutable (Requirement 10.4), so a months-old retrieval time for a
 *    months-old match says nothing about how current the profile is, and including
 *    them would drag `lastUpdated` back to a date that misrepresents the report.
 *
 *    Requirement 11.5 asks for "being retrieved for the first time" when no prior
 *    successful lookup has completed, and the cache is the only record of prior
 *    lookups, so `lastUpdated` is `null` exactly when every one of those four
 *    components was fetched fresh in this session. design.md's declared comment on
 *    the field — "null if never successfully retrieved before" — says the same.
 *
 * 8. `partialDataWarning` MEANS "THIS REPORT CAME FROM THE FALLBACK". It is
 *    `true` only on the Requirement 11.3 path, matching design.md's error table,
 *    which sets it for the budget-overrun row and no other. It is NOT set when
 *    individual match details fail on an otherwise healthy path: Requirement 3.3
 *    defines that as an exclusion with no user-facing error, and 3.4 already gives
 *    it a distinct user-visible consequence in `limitedDataNotice`. Conflating the
 *    two would make the warning fire so often it would stop carrying information.
 *
 * 9. THE PARALLEL TRIO REPORTS ITS FIRST FAILURE IN REQUIREMENT ORDER. Summoner,
 *    league and match-ids are fetched concurrently (design.md's sequence flow), so
 *    several can fail in one lookup. The reported failure is the first in the fixed
 *    order summoner, league, match-ids — the order Requirements 2.2, 2.3 and 3.1
 *    are written in — so the outcome never depends on which promise happened to
 *    settle first. Every auth failure among them is logged regardless of which one
 *    is reported, because Requirement 9.5's obligation is to log the occurrence,
 *    not the winner of a precedence contest.
 *
 * 10. REGION VALIDITY IS RE-CHECKED HERE, THOUGH THE TYPE ALREADY GUARANTEES IT.
 *    design.md assigns Requirement 5.5's rejection to callers, and the parameter
 *    is typed `RegionalRoutingValue`, so this guard is unreachable from
 *    type-checked code. It exists because the routing value is interpolated into
 *    the Riot host name: an unvalidated value arriving from an untyped caller (a
 *    JavaScript consumer, or a future route that forgets to validate) would
 *    otherwise be sent at a host we did not intend to contact. It is the one place
 *    where being redundant is cheaper than being sorry, and it makes
 *    `UNSUPPORTED_REGION` reachable rather than decorative.
 *
 * 11. THE FAN-OUT IS BOUNDED IN BOTH WIDTH AND LENGTH. Match details are fetched
 *    `MATCH_DETAIL_CONCURRENCY` at a time: fetching up to 100 sequentially could
 *    not fit the 15s budget, while firing all 100 at once would queue a burst
 *    inside the Rate Limit Manager that starves every other concurrent lookup of
 *    the same shared per-key window. The id list is also re-truncated to
 *    `MATCH_HISTORY_COUNT` even though the client already passes a `count`, so a
 *    malformed or oversized cached list can never turn one lookup into thousands
 *    of Riot calls.
 */

import {
  TTL_BY_ENDPOINT,
  type CacheEntry,
  type CacheKey,
  type CacheStore,
} from '../cache';
import { computeFunFacts, isLimitedData, averageMatchDurationMinutesOf, type FunFact } from '../insight/funFacts';
import { computeRecommendations, type Recommendation } from '../insight/recommendations';
import { computeStats, type IncludedMatch, type ProfileStats } from '../insight/stats';
import { isValidRegion, resolvePlatform, type PlatformRoutingValue, type RegionalRoutingValue } from '../region';
import type {
  AccountDto,
  LeagueEntryDto,
  MatchDto,
  RiotApiClient,
  SummonerDto,
  TimeoutScheduler,
} from '../riotApiClient';
import type { RiotIdParts } from '../validator';
import {
  cacheOrFetch,
  isCacheOrFetchFailure,
  type CacheOrFetchOutcome,
  type RiotApiFailure,
} from './cacheOrFetch';
import { toIncludedMatch, toLeagueEntries } from './mapping';

export {
  cacheOrFetch,
  isCacheOrFetchFailure,
  type CacheOrFetchFailure,
  type CacheOrFetchOutcome,
  type CacheOrFetchSuccess,
  type RiotApiFailure,
} from './cacheOrFetch';
export {
  ALLOWED_QUEUE_TYPES,
  QUEUE_TYPE_BY_QUEUE_ID,
  queueTypeForQueueId,
  toIncludedMatch,
  toLeagueEntries,
  toLeagueEntry,
  type AllowedQueueType,
} from './mapping';

/** Requirement 3.1: the Match_History_Window is at most this many matches. */
export const MATCH_HISTORY_COUNT = 100;

/** Requirements 11.2 / 11.3: overall budget for a fresh-path lookup. */
export const FRESH_PATH_BUDGET_MS = 15_000;

/** Decision 11: match details in flight at once. */
export const MATCH_DETAIL_CONCURRENCY = 10;

/** The pipeline stages, used for error attribution and server-side logging. */
export type LookupStage = 'account' | 'summoner' | 'league' | 'matchIds' | 'matchDetail';

/**
 * design.md's declared error codes, plus `PLAYER_NOT_ON_PLATFORM`.
 *
 * `PLAYER_NOT_ON_PLATFORM` was added after live testing (Finding A in the
 * implementation log). Riot accounts are global, so Account-V1 resolves a PUUID
 * regardless of where the player actually plays; Summoner-V4 then returns 404 on a
 * platform where they have no summoner. Before this code existed that surfaced as
 * `RIOT_UNAVAILABLE` — "Riot's services are temporarily unavailable" — which is
 * false and unactionable: nothing was unavailable and the visitor's input was
 * correct, they simply picked the wrong region. It is the most likely real failure
 * a region selector produces, so it earns its own code and its own message.
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNSUPPORTED_REGION'
  | 'PLAYER_NOT_FOUND'
  | 'PLAYER_NOT_ON_PLATFORM'
  | 'RIOT_UNAVAILABLE'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'AUTH_FAILURE'
  | 'NETWORK_ERROR'
  | 'MATCH_HISTORY_UNAVAILABLE';

/**
 * design.md's `ProfileReport`, plus `averageMatchDurationMinutes` (decision 1).
 */
export interface ProfileReport {
  riotId: RiotIdParts;
  puuid: string;
  summonerLevel: number;
  profileIconId: number;
  stats: ProfileStats;
  funFacts: FunFact[];
  /** Requirement 3.4 / 7.5: fewer than 5 included matches. */
  limitedDataNotice: boolean;
  recommendations: Recommendation[];
  /** Requirement 7.3, in minutes to 2 decimal places (decision 1). */
  averageMatchDurationMinutes: number;
  /** Requirements 11.4 / 11.5: ISO timestamp, or `null` on a first retrieval. */
  lastUpdated: string | null;
  /** Requirement 11.3: this report came from the cached fallback (decision 8). */
  partialDataWarning: boolean;
}

export type LookupResult =
  | { kind: 'success'; report: ProfileReport }
  | { kind: 'not_found'; gameName: string; tagLine: string }
  | { kind: 'error'; code: ErrorCode; retriable: boolean };

/**
 * design.md's `MatchHistoryWindow`. `attemptedCount` is the number of match ids
 * actually requested, before exclusions, so it is always >= `matches.length`;
 * `matches` is the included set that Requirements 3.3 and 3.5 leave behind.
 */
export interface MatchHistoryWindow {
  puuid: string;
  matches: IncludedMatch[];
  attemptedCount: number;
}

export interface LookupInput {
  riotId: RiotIdParts;
  region: RegionalRoutingValue;
  platform?: string;
}

export interface LookupOrchestrator {
  runLookup(input: LookupInput): Promise<LookupResult>;
}

/**
 * Requirement 9.5's server-side logging seam.
 *
 * Deliberately narrow: a rejected API key is the only failure the requirements
 * oblige the backend to log, so this is not a general logging facade. The
 * argument carries no key material and cannot — the Riot API Client never returns
 * the key to any caller, and this module never reads it.
 */
export interface LookupLogger {
  authFailure(info: { stage: LookupStage; routingValue: string; status: 401 | 403 }): void;
}

/**
 * Default logger. Requirement 9.5 requires the failure to be logged, so the
 * out-of-the-box behavior must actually log rather than drop it on the floor;
 * tests inject a recording logger instead.
 */
export const consoleLookupLogger: LookupLogger = {
  authFailure({ stage, routingValue, status }) {
    // eslint-disable-next-line no-console
    console.error(
      `[lolprofiles] Riot API rejected the configured credential: HTTP ${String(status)} at stage ` +
        `"${stage}" for routing value "${routingValue}". No credential material is logged.`,
    );
  },
};

export interface LookupOrchestratorOptions {
  cache: CacheStore;
  riotApiClient: RiotApiClient;
  /** Injected clock. Must be the SAME function the cache store was given. */
  now?: () => number;
  /** Injected budget timer; defaults to a `setTimeout`-based scheduler. */
  scheduleTimeout?: TimeoutScheduler;
  /** Requirement 9.5 sink; defaults to `consoleLookupLogger`. */
  logger?: LookupLogger;
  freshPathBudgetMs?: number;
  matchHistoryCount?: number;
  matchDetailConcurrency?: number;
}

const defaultTimeoutScheduler: TimeoutScheduler = (ms, onElapsed) => {
  const handle = setTimeout(onElapsed, ms);
  return () => {
    clearTimeout(handle);
  };
};

/** Sentinel resolved by the budget timer; distinct from every `LookupResult`. */
const BUDGET_EXPIRED = 'budget_expired';

interface BudgetGate {
  /** True once the budget has elapsed; polled by the fan-out (decision 5). */
  expired(): boolean;
  /** Resolves with `BUDGET_EXPIRED` when the budget elapses. */
  readonly expiry: Promise<typeof BUDGET_EXPIRED>;
  /** Disarms the timer. Called on every exit path (decision 6). */
  cancel(): void;
}

/** What one already-obtained component contributes to `lastUpdated` (decision 7). */
interface ComponentAge {
  fromCache: boolean;
  retrievedAt: number;
}

/** Mutable per-lookup state, so the fallback can run after the race is abandoned. */
interface LookupContext {
  region: RegionalRoutingValue;
  platform: PlatformRoutingValue;
  submittedRiotId: RiotIdParts;
  /** Set as soon as Account-V1 resolves; absent means no PUUID yet. */
  account?: { dto: AccountDto; age: ComponentAge };
}

interface StageFailure {
  stage: LookupStage;
  failure: RiotApiFailure;
}

class DefaultLookupOrchestrator implements LookupOrchestrator {
  private readonly cache: CacheStore;
  private readonly client: RiotApiClient;
  private readonly now: () => number;
  private readonly scheduleTimeout: TimeoutScheduler;
  private readonly logger: LookupLogger;
  private readonly freshPathBudgetMs: number;
  private readonly matchHistoryCount: number;
  private readonly matchDetailConcurrency: number;

  constructor(options: LookupOrchestratorOptions) {
    this.cache = options.cache;
    this.client = options.riotApiClient;
    this.now = options.now ?? Date.now;
    this.scheduleTimeout = options.scheduleTimeout ?? defaultTimeoutScheduler;
    this.logger = options.logger ?? consoleLookupLogger;
    this.freshPathBudgetMs = options.freshPathBudgetMs ?? FRESH_PATH_BUDGET_MS;
    this.matchHistoryCount = options.matchHistoryCount ?? MATCH_HISTORY_COUNT;
    this.matchDetailConcurrency = Math.max(1, options.matchDetailConcurrency ?? MATCH_DETAIL_CONCURRENCY);
  }

  /**
   * Runs one Lookup_Session. Never throws for an expected outcome: every failure
   * is a typed `LookupResult`, matching the Riot API Client's contract.
   */
  async runLookup(input: LookupInput): Promise<LookupResult> {
    // Decision 10: defense in depth for untyped callers.
    if (!isValidRegion(input.region)) {
      return { kind: 'error', code: 'UNSUPPORTED_REGION', retriable: false };
    }

    const ctx: LookupContext = {
      region: input.region,
      platform: resolvePlatform(input.region, input.platform), // Requirements 2.5 / 5.4
      submittedRiotId: input.riotId,
    };

    const gate = this.openBudgetGate();
    try {
      // Decision 5: the budget cancels the WAIT, it does not merely observe it.
      const outcome = await Promise.race([this.runPipeline(ctx, gate), gate.expiry]);

      if (outcome !== BUDGET_EXPIRED) {
        return outcome;
      }

      // Requirement 11.3: stop waiting and serve the last-known cache.
      const fallback = await this.buildFallbackReport(ctx);
      return fallback === undefined
        ? { kind: 'error', code: 'TIMEOUT', retriable: false }
        : { kind: 'success', report: fallback };
    } finally {
      gate.cancel();
    }
  }

  /**
   * The happy path, plus the failure branches that can end it. Runs inside the
   * budget race, so it may be abandoned mid-flight; everything it needs to hand
   * over to the fallback is recorded on `ctx` as soon as it is known.
   */
  private async runPipeline(ctx: LookupContext, gate: BudgetGate): Promise<LookupResult> {
    // --- Phase 1: Account-V1 (Requirement 2.1) ---------------------------------
    const account = await cacheOrFetch<AccountDto>(
      this.cache,
      this.accountKey(ctx),
      TTL_BY_ENDPOINT.account,
      () => this.client.getAccountByRiotId(ctx.region, ctx.submittedRiotId.gameName, ctx.submittedRiotId.tagLine),
      this.now,
    );

    if (isCacheOrFetchFailure(account)) {
      this.logAuthFailure('account', ctx.region, account.failure);
      if (account.failure.kind === 'not_found') {
        // Requirements 2.4 / 9.2. Returning here is what guarantees no
        // Summoner-V4/League-V4/Match-V5 call is issued, and `cacheOrFetch` only
        // writes on success, so no partial state was persisted either.
        return {
          kind: 'not_found',
          gameName: ctx.submittedRiotId.gameName,
          tagLine: ctx.submittedRiotId.tagLine,
        };
      }
      // No PUUID yet, so the Requirement 11.3 fallback is not available.
      return this.errorFor('account', account.failure);
    }

    const puuid = typeof account.value?.puuid === 'string' ? account.value.puuid : '';
    if (puuid === '') {
      // A 200 that carries no PUUID is a response we cannot read as data, the
      // same condition the Riot API Client maps to `server_error` (its decision 3).
      return { kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true };
    }
    ctx.account = { dto: account.value, age: ageOf(account) };

    // --- Phase 2: summoner + league + match ids, concurrently -----------------
    const [summoner, league, matchIds] = await Promise.all([
      cacheOrFetch<SummonerDto>(
        this.cache,
        { endpoint: 'summoner', routingValue: ctx.platform, params: { puuid } },
        TTL_BY_ENDPOINT.summoner,
        () => this.client.getSummonerByPuuid(ctx.platform, puuid), // Requirement 2.2
        this.now,
      ),
      cacheOrFetch<LeagueEntryDto[]>(
        this.cache,
        { endpoint: 'league', routingValue: ctx.platform, params: { puuid } },
        TTL_BY_ENDPOINT.league,
        () => this.client.getLeagueEntriesByPuuid(ctx.platform, puuid), // Requirement 2.3
        this.now,
      ),
      cacheOrFetch<string[]>(
        this.cache,
        { endpoint: 'matchIds', routingValue: ctx.region, params: { puuid } },
        TTL_BY_ENDPOINT.matchIds,
        () => this.client.getMatchIdsByPuuid(ctx.region, puuid, this.matchHistoryCount), // Requirement 3.1
        this.now,
      ),
    ]);

    // Decision 9: fixed reporting order, but log every auth failure.
    const stages: { stage: LookupStage; outcome: CacheOrFetchOutcome<unknown> }[] = [
      { stage: 'summoner', outcome: summoner },
      { stage: 'league', outcome: league },
      { stage: 'matchIds', outcome: matchIds },
    ];
    const failures: StageFailure[] = [];
    for (const { stage, outcome } of stages) {
      if (isCacheOrFetchFailure(outcome)) {
        this.logAuthFailure(stage, stage === 'matchIds' ? ctx.region : ctx.platform, outcome.failure);
        failures.push({ stage, failure: outcome.failure });
      }
    }

    if (failures.length > 0) {
      // Requirements 2.7 / 3.6 / 11.3, composed per decision 4.
      const fallback = await this.buildFallbackReport(ctx);
      if (fallback !== undefined) {
        return { kind: 'success', report: fallback };
      }
      return this.errorFor(failures[0].stage, failures[0].failure);
    }

    // Type narrowing: the loop above proved all three succeeded.
    if (isCacheOrFetchFailure(summoner) || isCacheOrFetchFailure(league) || isCacheOrFetchFailure(matchIds)) {
      return { kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true };
    }

    // --- Phase 3: match details (Requirements 3.2, 3.3, 3.5) ------------------
    const window = await this.fetchMatchDetails(ctx, puuid, matchIds.value, gate);

    return {
      kind: 'success',
      report: this.assembleReport({
        ctx,
        puuid,
        summoner: summoner.value,
        league: league.value,
        matches: window.matches,
        ages: [ageOf(account), ageOf(summoner), ageOf(league), ageOf(matchIds)],
        partialDataWarning: false,
      }),
    };
  }

  /**
   * Requirements 3.2/3.3/3.5. Fetches each match detail through `cacheOrFetch`,
   * excluding — without halting — any match that fails to fetch for ANY reason
   * (including timeout and rate limiting) or whose queue type is not allowed.
   *
   * Bounded in width and length per decision 11, and stops issuing new requests
   * once the budget has elapsed (decision 5).
   */
  private async fetchMatchDetails(
    ctx: LookupContext,
    puuid: string,
    rawMatchIds: string[],
    gate: BudgetGate,
  ): Promise<MatchHistoryWindow> {
    const matchIds = (Array.isArray(rawMatchIds) ? rawMatchIds : [])
      .filter((matchId): matchId is string => typeof matchId === 'string' && matchId.length > 0)
      .slice(0, this.matchHistoryCount);

    const matches: IncludedMatch[] = [];
    let attemptedCount = 0;

    for (let start = 0; start < matchIds.length; start += this.matchDetailConcurrency) {
      if (gate.expired()) {
        break;
      }
      const batch = matchIds.slice(start, start + this.matchDetailConcurrency);
      attemptedCount += batch.length;

      const outcomes = await Promise.all(
        batch.map((matchId) =>
          cacheOrFetch<MatchDto>(
            this.cache,
            { endpoint: 'matchDetail', routingValue: ctx.region, params: { matchId } },
            TTL_BY_ENDPOINT.matchDetail,
            () => this.client.getMatchById(ctx.region, matchId), // Requirement 3.2
            this.now,
          ),
        ),
      );

      for (const outcome of outcomes) {
        if (isCacheOrFetchFailure(outcome)) {
          // Requirement 3.3: exclude this match, keep going.
          this.logAuthFailure('matchDetail', ctx.region, outcome.failure);
          continue;
        }
        // Requirement 3.5 and the mapping module's exclusion rules.
        const included = toIncludedMatch(outcome.value, puuid);
        if (included !== undefined) {
          matches.push(included);
        }
      }
    }

    return { puuid, matches, attemptedCount };
  }

  /**
   * Requirement 11.3's fallback (decision 4). Reads the cache DIRECTLY rather
   * than through `cacheOrFetch`, because it must accept stale entries and must
   * never issue a Riot call — the whole point is that the fresh path already
   * failed or ran out of time.
   *
   * Returns `undefined` when a complete snapshot is not available, which is the
   * signal to report an error instead (Requirements 2.7 / 3.6). "Complete" means
   * the PUUID is known and the summoner, league and match-ids entries all exist;
   * individual match details may be missing, which is the same tolerated
   * exclusion Requirement 3.3 defines on the fresh path.
   */
  private async buildFallbackReport(ctx: LookupContext): Promise<ProfileReport | undefined> {
    const account = ctx.account;
    if (account === undefined) {
      return undefined;
    }
    const puuid = account.dto.puuid;

    const summoner = await this.readCached<SummonerDto>({
      endpoint: 'summoner',
      routingValue: ctx.platform,
      params: { puuid },
    });
    const league = await this.readCached<LeagueEntryDto[]>({
      endpoint: 'league',
      routingValue: ctx.platform,
      params: { puuid },
    });
    const matchIds = await this.readCached<string[]>({
      endpoint: 'matchIds',
      routingValue: ctx.region,
      params: { puuid },
    });

    if (summoner === undefined || league === undefined || matchIds === undefined) {
      return undefined;
    }

    const ids = (Array.isArray(matchIds.value) ? matchIds.value : [])
      .filter((matchId): matchId is string => typeof matchId === 'string' && matchId.length > 0)
      .slice(0, this.matchHistoryCount);

    const matches: IncludedMatch[] = [];
    for (const matchId of ids) {
      const entry = await this.readCached<MatchDto>({
        endpoint: 'matchDetail',
        routingValue: ctx.region,
        params: { matchId },
      });
      if (entry === undefined) {
        continue;
      }
      const included = toIncludedMatch(entry.value, puuid);
      if (included !== undefined) {
        matches.push(included);
      }
    }

    return this.assembleReport({
      ctx,
      puuid,
      summoner: summoner.value,
      league: league.value,
      matches,
      ages: [
        account.age,
        { fromCache: true, retrievedAt: summoner.retrievedAt },
        { fromCache: true, retrievedAt: league.retrievedAt },
        { fromCache: true, retrievedAt: matchIds.retrievedAt },
      ],
      partialDataWarning: true, // Requirement 11.3
    });
  }

  /**
   * Reads an entry regardless of staleness, treating a throwing cache as a miss
   * for the same reason `cacheOrFetch` does (its decision 3): a cache outage must
   * degrade the answer, not replace it with an exception.
   */
  private async readCached<T>(key: CacheKey): Promise<CacheEntry<T> | undefined> {
    try {
      return await this.cache.get<T>(key);
    } catch {
      return undefined;
    }
  }

  /** Runs the Insight Engine over the assembled data and builds the report. */
  private assembleReport(args: {
    ctx: LookupContext;
    puuid: string;
    summoner: SummonerDto;
    league: LeagueEntryDto[];
    matches: IncludedMatch[];
    ages: ComponentAge[];
    partialDataWarning: boolean;
  }): ProfileReport {
    const { ctx, puuid, summoner, matches, ages, partialDataWarning } = args;
    // Requirements 2.8 / 6.1: an empty or unreadable entry list is Unranked.
    const league = toLeagueEntries(args.league);
    const stats = computeStats(matches, league, puuid);

    return {
      riotId: canonicalRiotId(ctx),
      puuid,
      summonerLevel: finiteOrZero(summoner?.summonerLevel),
      profileIconId: finiteOrZero(summoner?.profileIconId),
      stats,
      funFacts: computeFunFacts(matches), // Requirements 7.1-7.6
      limitedDataNotice: isLimitedData(matches), // Requirements 3.4 / 7.5
      recommendations: computeRecommendations(matches, stats), // Requirements 8.1-8.5
      averageMatchDurationMinutes: averageMatchDurationMinutesOf(matches), // Requirement 7.3
      lastUpdated: lastUpdatedOf(ages), // Requirements 11.4 / 11.5
      partialDataWarning,
    };
  }

  /**
   * Requirement 9's error table (decisions 2 and 3).
   *
   * | failure kind  | code                                              | retriable |
   * |---------------|---------------------------------------------------|-----------|
   * | auth_error    | AUTH_FAILURE                             (9.5)    | false     |
   * | timeout       | TIMEOUT                                  (9.4)    | false     |
   * | rate_limited  | RATE_LIMITED                             (9.8)    | true      |
   * | network_error | NETWORK_ERROR                            (9.9)    | true      |
   * | server_error  | MATCH_HISTORY_UNAVAILABLE at matchIds    (3.6),   | true      |
   * |               | RIOT_UNAVAILABLE elsewhere               (9.3)    |           |
   * | not_found     | PLAYER_NOT_ON_PLATFORM at summoner       (9.10),  | false     |
   * |               | MATCH_HISTORY_UNAVAILABLE at matchIds    (3.6),   |           |
   * |               | RIOT_UNAVAILABLE elsewhere                        |           |
   *
   * The `not_found`-at-summoner row is Requirement 9.10 (Finding A): Summoner-V4
   * answering 404 for a PUUID that Account-V1 just resolved means precisely one
   * thing — the player has no summoner on the platform we asked about. That is a
   * statement about the region selection, not about Riot's health, so it must not
   * share `RIOT_UNAVAILABLE`'s message. League-V4 is deliberately NOT included: it
   * returns 200 with an empty array for an unranked player (Requirement 2.8), so a
   * 404 there is an unreadable response rather than evidence about the platform.
   *
   * `retriable` drives Requirement 9.3's bounded, explicitly-initiated retry
   * affordance, so it is `true` exactly for the three rows design.md's error
   * table marks retriable: a temporarily unavailable Riot service, a rate limit
   * (after 9.8's cooldown), and a network error. A rejected credential and an
   * absent resource do not become available by asking again, and a timeout gets
   * its own distinct user-facing state rather than an in-place retry button. The
   * visitor can of course always submit a new lookup.
   */
  private errorFor(stage: LookupStage, failure: RiotApiFailure): LookupResult {
    switch (failure.kind) {
      case 'auth_error':
        return { kind: 'error', code: 'AUTH_FAILURE', retriable: false };
      case 'timeout':
        return { kind: 'error', code: 'TIMEOUT', retriable: false };
      case 'rate_limited':
        return { kind: 'error', code: 'RATE_LIMITED', retriable: true };
      case 'network_error':
        return { kind: 'error', code: 'NETWORK_ERROR', retriable: true };
      case 'server_error':
        return {
          kind: 'error',
          code: stage === 'matchIds' ? 'MATCH_HISTORY_UNAVAILABLE' : 'RIOT_UNAVAILABLE',
          retriable: true,
        };
      case 'not_found':
        if (stage === 'summoner') {
          // Requirement 9.10 / Finding A.
          return { kind: 'error', code: 'PLAYER_NOT_ON_PLATFORM', retriable: false };
        }
        return {
          kind: 'error',
          code: stage === 'matchIds' ? 'MATCH_HISTORY_UNAVAILABLE' : 'RIOT_UNAVAILABLE',
          retriable: false,
        };
    }
  }

  /** Requirement 9.5. Logs 401/403 and nothing else; carries no key material. */
  private logAuthFailure(stage: LookupStage, routingValue: string, failure: RiotApiFailure): void {
    if (failure.kind === 'auth_error') {
      this.logger.authFailure({ stage, routingValue, status: failure.status });
    }
  }

  /** Arms the Requirement 11.2/11.3 budget (decisions 5 and 6). */
  private openBudgetGate(): BudgetGate {
    let expired = false;
    let disarm: () => void = () => {
      /* replaced synchronously below */
    };
    const expiry = new Promise<typeof BUDGET_EXPIRED>((resolve) => {
      disarm = this.scheduleTimeout(this.freshPathBudgetMs, () => {
        expired = true;
        resolve(BUDGET_EXPIRED);
      });
    });
    return {
      expired: () => expired,
      expiry,
      cancel: () => {
        disarm();
      },
    };
  }

  private accountKey(ctx: LookupContext): CacheKey {
    return {
      endpoint: 'account',
      routingValue: ctx.region,
      params: { gameName: ctx.submittedRiotId.gameName, tagLine: ctx.submittedRiotId.tagLine },
    };
  }
}

/** Reads a `cacheOrFetch` success as a `lastUpdated` contribution (decision 7). */
function ageOf(outcome: CacheOrFetchOutcome<unknown>): ComponentAge {
  if (isCacheOrFetchFailure(outcome)) {
    // Unreachable for callers, which only pass successes; kept total so the
    // helper cannot be misused into inventing a timestamp.
    return { fromCache: false, retrievedAt: 0 };
  }
  return { fromCache: outcome.fromCache, retrievedAt: outcome.retrievedAt };
}

/**
 * Requirements 11.4 / 11.5 (decision 7): the oldest profile-state component's
 * retrieval time as an ISO timestamp, or `null` when every component was fetched
 * fresh in this session and therefore nothing was "retrieved before".
 */
export function lastUpdatedOf(ages: readonly ComponentAge[]): string | null {
  if (!ages.some((age) => age.fromCache)) {
    return null;
  }
  const oldest = Math.min(...ages.map((age) => age.retrievedAt));
  return new Date(oldest).toISOString();
}

/**
 * The Riot ID shown on the report. Account-V1 echoes the canonical casing Riot
 * holds, which is what a visitor should see, so it wins over the submitted text
 * when it is present and non-blank; the submitted value is the fallback so the
 * report always names a player.
 */
function canonicalRiotId(ctx: LookupContext): RiotIdParts {
  const dto = ctx.account?.dto;
  const gameName = typeof dto?.gameName === 'string' && dto.gameName.trim().length > 0 ? dto.gameName : undefined;
  const tagLine = typeof dto?.tagLine === 'string' && dto.tagLine.trim().length > 0 ? dto.tagLine : undefined;
  return {
    gameName: gameName ?? ctx.submittedRiotId.gameName,
    tagLine: tagLine ?? ctx.submittedRiotId.tagLine,
  };
}

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function createLookupOrchestrator(options: LookupOrchestratorOptions): LookupOrchestrator {
  return new DefaultLookupOrchestrator(options);
}
