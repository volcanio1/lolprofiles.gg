/**
 * Lookup Orchestrator.
 *
 * The coordination layer Requirements 2, 3, 9, 10 and 11 are really specifying:
 * it turns a validated Riot ID into a `ProfileReport`, or into a typed failure.
 * It owns cache-or-fetch sequencing, platform resolution (lookup-pipeline-fixes
 * Requirement 1, via the injected Region Resolver), the queue-type filter, the
 * Insight Engine invocation, the Requirement 9 error mapping, and the 15s
 * fresh-path budget with its fall back to last-known cache.
 *
 * Every collaborator is injected — cache, Riot API client, region resolver,
 * clock, budget scheduler, logger — so no test needs a network, a real timer or
 * a credential, matching every other module in this build.
 *
 * lookup-pipeline-fixes note: this file's input no longer carries a region at
 * all — see `LookupInput` — because the platform is now DISCOVERED from the
 * PUUID via Account-V1's region-by-game-by-puuid endpoint (the Region Resolver)
 * rather than guessed from a visitor-selected dropdown. Every "Implements" bullet
 * and decision below that referenced the old guessed-region flow has been
 * updated in place; nothing here still describes the pre-lookup-pipeline-fixes
 * behavior.
 *
 * Implements:
 *  - 2.1: Account-V1 resolves the PUUID first, against the fixed Discovery_Region.
 *  - 1.1-1.4: the Region Resolver determines the Resolved_Platform and
 *    Derived_Region from the PUUID (or a diagnostic `platformOverride`), and
 *    every subsequent platform-routed and region-routed call uses it.
 *  - 2.2 / 2.3: Summoner-V4 (now an Enrichment_Call, Requirement 4) and League-V4
 *    by PUUID, using the Resolved_Platform.
 *  - 2.4: an Account-V1 not-found halts the pipeline before any region
 *    resolution, League-V4 or Match-V5 call, and leaves nothing behind.
 *  - 4.1-4.5: Summoner-V4 is an Enrichment_Call whose outcome never produces an
 *    error code or halts the pipeline; see `enrich`.
 *  - 5.1-5.4: the Region Resolver's four outcomes map onto `NO_LOL_ACCOUNT`,
 *    `UNSUPPORTED_PLATFORM`, a normal pipeline continuation, or a surfaced
 *    underlying error with no guessed fallback, respectively.
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
 * 9. THE REQUIRED PAIR REPORTS ITS FIRST FAILURE IN REQUIREMENT ORDER
 *    (lookup-pipeline-fixes revision). League-V4 and Match-V5 match-ids are
 *    fetched concurrently alongside the Summoner-V4 Enrichment_Call (design.md's
 *    sequence flow), so either of the first two can fail in one lookup —
 *    Summoner-V4 no longer can, structurally (Requirement 4.5; see `enrich`). The
 *    reported failure is the first in the fixed order league, match-ids — the
 *    order Requirements 2.3 and 3.1 are written in — so the outcome never depends
 *    on which promise happened to settle first. Every auth failure among all
 *    three, INCLUDING the enrichment call, is logged regardless of which one (if
 *    any) is reported as a `LookupResult` error, because Requirement 9.5's
 *    obligation is to log the occurrence, not the winner of a precedence contest.
 *
 * 10. lookup-pipeline-fixes REMOVED THIS DECISION'S GUARD ENTIRELY. It used to
 *    re-validate a visitor-supplied region here as defense in depth, because that
 *    value was interpolated into the Riot host name. `LookupInput` no longer
 *    carries a region at all — the Discovery_Region is a fixed configuration
 *    value (never visitor input) and the Derived_Region comes from
 *    `regionForPlatform`, which is total over the closed `PlatformRoutingValue`
 *    domain by construction — so there is no longer an untyped region string
 *    that could reach a host interpolation. The equivalent defense-in-depth
 *    concern for `platformOverride` is handled inline in `runPipeline`: an
 *    unsupported override is treated as no override at all (falls through to the
 *    Region Resolver) rather than being rejected outright, since it is a
 *    diagnostic-only field never exposed in the default UI (Requirement 2.4) and
 *    silently falling back to correct resolution is strictly safer than a
 *    fatal error for a field visitors don't see.
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
import { computeRecentMatches, type RecentMatchSummary } from '../insight/recentMatches';
import { computeRecommendations, type Recommendation } from '../insight/recommendations';
import { computePremades, type PremadeEntry } from '../insight/premades';
import { computeRolePerformance, type RolePerformanceEntry } from '../insight/rolePerformance';
import { computeStats, type IncludedMatch, type LanelessMatch, type ProfileStats } from '../insight/stats';
import {
  DEFAULT_REGION,
  isSupportedPlatform,
  regionForPlatform,
  type PlatformRoutingValue,
  type RegionalRoutingValue,
} from '../region';
import { createNoopRankHistoryStore, type RankHistoryStore, type RankSnapshot } from '../db/rankHistoryStore';
import { createNoopLookedUpPlayerStore, type LookedUpPlayerStore } from '../db/lookedUpPlayerStore';
import { createNoopProfileSnapshotStore, type ProfileSnapshotStore } from '../db/profileSnapshotStore';
import { createNoopMatchStore, type MatchStore, type StoredMatch } from '../db/matchStore';
import { createRegionResolver, type RegionResolver } from '../regionResolver';
import type {
  AccountDto,
  LeagueEntryDto,
  MatchDto,
  RiotApiClient,
  RiotApiResult,
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
import {
  ALLOWED_QUEUE_TYPES,
  toIncludedMatch,
  toLanelessMatch,
  toLeagueEntries,
  type AllowedQueueType,
} from './mapping';

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

/**
 * The raw League-V4 `queueType` for Ranked Solo/Duo — the key under which that
 * standing appears in `ProfileStats.rankedByQueue`. specs/database/ Requirement
 * 2.1 records a rank snapshot for this queue only; specs/profile-sidebar/
 * Requirement 10.3 scopes the graph to it.
 */
export const SOLO_QUEUE_TYPE = 'RANKED_SOLO_5x5';

/**
 * The pipeline stages, used for error attribution and server-side logging.
 *
 * lookup-pipeline-fixes: `regionResolution` is new (the Region Resolver's own
 * call can fail the same ways any Riot call can). `summoner` remains in this
 * union for Requirement 9.5's auth-failure logging only — Summoner-V4 is now an
 * Enrichment_Call (Requirement 4) and never reaches `errorFor`, so `summoner`
 * never appears in a `StageFailure` or drives a `LookupResult` anymore.
 */
export type LookupStage = 'account' | 'regionResolution' | 'summoner' | 'league' | 'matchIds' | 'matchDetail';

/**
 * design.md's declared error codes, revised by lookup-pipeline-fixes.
 *
 * `PLAYER_NOT_ON_PLATFORM` and `UNSUPPORTED_REGION` are REMOVED. Both existed to
 * name a wrong-region guess after the fact — `PLAYER_NOT_ON_PLATFORM` was
 * Summoner-V4's 404 standing in for "the visitor picked the wrong region"
 * (Finding A in the implementation log), and `UNSUPPORTED_REGION` validated a
 * visitor-supplied region that no longer exists as an input at all now that the
 * Region Resolver determines it from the PUUID. Neither condition can occur
 * anymore: there is no region to guess wrong, and no region field to validate.
 *
 * `NO_LOL_ACCOUNT` and `UNSUPPORTED_PLATFORM` are NEW, and replace them
 * structurally rather than cosmetically — they are Requirement 5's two
 * Region_Resolver outcomes that mean the visitor's Riot ID is correct but this
 * system still cannot proceed, which is exactly the gap `PLAYER_NOT_ON_PLATFORM`
 * used to (mis)cover via a symptom two calls downstream.
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'PLAYER_NOT_FOUND'
  | 'NO_LOL_ACCOUNT'
  | 'UNSUPPORTED_PLATFORM'
  | 'RIOT_UNAVAILABLE'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'AUTH_FAILURE'
  | 'NETWORK_ERROR'
  | 'MATCH_HISTORY_UNAVAILABLE';

/**
 * profile-sidebar Requirement 7/8/9: the values a Gamemode_Filter can hold —
 * `'all'` or one Allowed_Queue_Type. Every per-queue slice on the report is
 * keyed by this.
 */
export type QueueFilterValue = 'all' | AllowedQueueType;

/** `'all'` first, then the Allowed_Queue_Types in their declared order. */
export const QUEUE_FILTER_VALUES: readonly QueueFilterValue[] = ['all', ...ALLOWED_QUEUE_TYPES];

/**
 * design.md's `ProfileReport`, plus `averageMatchDurationMinutes` (decision 1).
 */
export interface ProfileReport {
  riotId: RiotIdParts;
  puuid: string;
  /**
   * Null exactly when `profileIconId` is (Requirement 4.2/4.3): the Summoner-V4
   * Enrichment_Call failed. Was unconditionally `number` (coerced with
   * `finiteOrZero`) before this spec demoted Summoner-V4 off the required path.
   */
  summonerLevel: number | null;
  /**
   * Null when the summoner payload carried no usable icon id.
   *
   * Nullable for two independent reasons, and BOTH must hold for this to stay
   * nullable — do not revert it if one of them goes away:
   *  1. `0` is a real profile icon (Data Dragon serves `profileicon/0.png` with a
   *     200, verified in the visual-assets spec's task 1.1), so coercing an absent
   *     value to `0` renders a specific picture nobody chose. Absent must be
   *     distinguishable from icon zero.
   *  2. The lookup-pipeline-fixes spec demotes Summoner-V4 to a non-blocking
   *     enrichment call, whose failure leaves this field absent on an otherwise
   *     successful report.
   */
  profileIconId: number | null;
  /** Requirement 2: the Platform_Routing_Value the Region Resolver settled on. */
  resolvedPlatform: PlatformRoutingValue;
  /** Requirement 2.4: true when `platformOverride` was supplied and used verbatim. */
  usedPlatformOverride: boolean;
  stats: ProfileStats;
  /**
   * profile-sidebar Requirement 7.1 / 8.1: the same computations as `stats`
   * (champions, KDA, role) plus per-role performance, computed once for `'all'`
   * and once per Allowed_Queue_Type. `statsByQueue['all']` is identical to
   * `stats` — this is additive, not a rename; every existing `report.stats`
   * consumer is unaffected. The `rankedByQueue` field inside each slice is the
   * player's full current standing (it is not match-derived), so it is the same
   * in every slice.
   */
  statsByQueue: Record<QueueFilterValue, ProfileStats>;
  rolePerformanceByQueue: Record<QueueFilterValue, RolePerformanceEntry[]>;
  /**
   * Teammates the analyzed player has queued with in 2+ of the included matches,
   * with games + win rate together, per Queue_Filter_Value. Keyed by Riot ID
   * (participant records carry no PUUID). Empty when match participant lists are
   * unavailable.
   */
  premadesByQueue: Record<QueueFilterValue, PremadeEntry[]>;
  /**
   * profile-sidebar Requirement 10.3: recorded Ranked Solo/Duo rank snapshots for
   * this PUUID, oldest first. Empty when none have been recorded yet, when the
   * persistent store is disabled, or when the read failed — the store is
   * supplementary and its unavailability must never fail a lookup (design.md
   * Error Handling).
   */
  rankHistory: RankSnapshot[];
  funFacts: FunFact[];
  /** Requirement 3.4 / 7.5: fewer than 5 included matches. */
  limitedDataNotice: boolean;
  recommendations: Recommendation[];
  /** Requirement 7.3, in minutes to 2 decimal places (decision 1). */
  averageMatchDurationMinutes: number;
  /** Newest-first, capped at `RECENT_MATCH_TRANSPORT_LIMIT`; each carries the lane opponent's stats when known. */
  recentMatches: RecentMatchSummary[];
  /** Requirements 11.4 / 11.5: ISO timestamp, or `null` on a first retrieval. */
  lastUpdated: string | null;
  /** Requirement 11.3: this report came from the cached fallback (decision 8). */
  partialDataWarning: boolean;
}

export type LookupResult =
  | { kind: 'success'; report: ProfileReport }
  | { kind: 'not_found'; gameName: string; tagLine: string }
  | {
      kind: 'error';
      code: ErrorCode;
      retriable: boolean;
      /**
       * lookup-pipeline-fixes Requirement 5.3: set only for `UNSUPPORTED_PLATFORM`,
       * the platform Riot itself named — the route cannot recompute this the way
       * it used to recompute a guessed platform (Finding A), because it came from
       * Riot's own response, not from a deterministic function of the request.
       */
      platform?: string;
    };

/**
 * design.md's `MatchHistoryWindow`. `attemptedCount` is the number of match ids
 * actually requested, before exclusions, so it is always >= `matches.length`;
 * `matches` is the included set that Requirements 3.3 and 3.5 leave behind.
 */
export interface MatchHistoryWindow {
  puuid: string;
  matches: IncludedMatch[];
  /** `match-detail-tabs` Requirement 11.1: ARAM and ARAM Mayhem matches, kept separate from `matches`. */
  lanelessMatches: LanelessMatch[];
  attemptedCount: number;
}

export interface LookupInput {
  riotId: RiotIdParts;
  /**
   * Requirement 2.4: a diagnostic escape hatch, absent from the default UI. When
   * supplied, it is used in place of the Region Resolver's call, and the
   * resulting report is marked `usedPlatformOverride: true`. An unsupported value
   * here is treated as if no override were given (falls through to normal
   * resolution) rather than as a fatal input error — see `runPipeline`.
   */
  platformOverride?: PlatformRoutingValue;
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
  /**
   * specs/database/ Requirement 4.2. A Persistent_Store write hook rejected. This
   * is an operational note, not a defect: the lookup succeeded and the visitor
   * was unaffected — only the rank snapshot / remembered-player row was not
   * written. Defaults to a single `console.warn`.
   */
  storeWriteFailed(info: { reason: unknown }): void;
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
  storeWriteFailed({ reason }) {
    // eslint-disable-next-line no-console
    console.warn('[lolprofiles] Persistent store write failed (lookup was unaffected):', reason);
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
  /**
   * The Discovery_Region: a configuration value, not a visitor input, since
   * Account-V1's by-riot-id and region-by-game-by-puuid calls are global and any
   * regional host answers them (design.md). Defaults to `DEFAULT_REGION`.
   */
  discoveryRegion?: RegionalRoutingValue;
  /** Injectable for tests; defaults to one built from the options above. */
  regionResolver?: RegionResolver;
  /**
   * Persistent_Store write targets (specs/database/). Optional — omitted means
   * the no-op stores, which is also the runtime state when `MONGODB_URI` is
   * unset. Written to only as unawaited side effects of a fresh successful
   * lookup (`recordLookupSideEffects`); a slow or failing store can never delay
   * or fail a lookup (Requirement 4).
   */
  rankHistoryStore?: RankHistoryStore;
  lookedUpPlayerStore?: LookedUpPlayerStore;
  /**
   * autofill-search Requirement 8: the full `ProfileReport` is saved here on
   * every fresh successful lookup, same fire-and-forget discipline as the other
   * two stores. Omitted ⇒ the no-op store.
   */
  profileSnapshotStore?: ProfileSnapshotStore;
  /**
   * match-cache Requirement 3/4: consulted before the Match-V5 detail fan-out
   * (bounded, fail-safe) and written to afterwards (fire-and-forget). Omitted ⇒
   * the no-op store, so the fan-out always fetches from Riot as today.
   */
  matchStore?: MatchStore;
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

/** Requirement 1: the outcome of platform resolution, however it was obtained. */
interface ResolvedRouting {
  platform: PlatformRoutingValue;
  region: RegionalRoutingValue;
  /** Requirement 2.4. */
  usedOverride: boolean;
}

/** Mutable per-lookup state, so the fallback can run after the race is abandoned. */
interface LookupContext {
  submittedRiotId: RiotIdParts;
  /** Set as soon as Account-V1 resolves; absent means no PUUID yet. */
  account?: { dto: AccountDto; age: ComponentAge };
  /**
   * Set once the platform is known, whether by the Region Resolver or by
   * `platformOverride`. Absent means the fallback (Requirement 11.3) has nothing
   * to route platform-scoped cache reads with, and cannot proceed — see
   * `buildFallbackReport`.
   */
  resolved?: ResolvedRouting;
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
  private readonly discoveryRegion: RegionalRoutingValue;
  private readonly regionResolver: RegionResolver;
  private readonly rankHistoryStore: RankHistoryStore;
  private readonly lookedUpPlayerStore: LookedUpPlayerStore;
  private readonly profileSnapshotStore: ProfileSnapshotStore;
  private readonly matchStore: MatchStore;

  constructor(options: LookupOrchestratorOptions) {
    this.cache = options.cache;
    this.client = options.riotApiClient;
    this.now = options.now ?? Date.now;
    this.scheduleTimeout = options.scheduleTimeout ?? defaultTimeoutScheduler;
    this.logger = options.logger ?? consoleLookupLogger;
    this.freshPathBudgetMs = options.freshPathBudgetMs ?? FRESH_PATH_BUDGET_MS;
    this.matchHistoryCount = options.matchHistoryCount ?? MATCH_HISTORY_COUNT;
    this.matchDetailConcurrency = Math.max(1, options.matchDetailConcurrency ?? MATCH_DETAIL_CONCURRENCY);
    this.rankHistoryStore = options.rankHistoryStore ?? createNoopRankHistoryStore();
    this.lookedUpPlayerStore = options.lookedUpPlayerStore ?? createNoopLookedUpPlayerStore();
    this.profileSnapshotStore = options.profileSnapshotStore ?? createNoopProfileSnapshotStore();
    this.matchStore = options.matchStore ?? createNoopMatchStore();
    this.discoveryRegion = options.discoveryRegion ?? DEFAULT_REGION;
    this.regionResolver =
      options.regionResolver ??
      createRegionResolver({
        client: this.client,
        cache: this.cache,
        discoveryRegion: this.discoveryRegion,
        now: this.now,
      });
  }

  /**
   * Runs one Lookup_Session. Never throws for an expected outcome: every failure
   * is a typed `LookupResult`, matching the Riot API Client's contract.
   */
  async runLookup(input: LookupInput): Promise<LookupResult> {
    const ctx: LookupContext = { submittedRiotId: input.riotId };

    const gate = this.openBudgetGate();
    try {
      // Decision 5: the budget cancels the WAIT, it does not merely observe it.
      const outcome = await Promise.race([this.runPipeline(ctx, gate, input.platformOverride), gate.expiry]);

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
  private async runPipeline(
    ctx: LookupContext,
    gate: BudgetGate,
    platformOverride: PlatformRoutingValue | undefined,
  ): Promise<LookupResult> {
    // --- Phase 1: Account-V1 (Requirement 2.1), against the Discovery_Region --
    const account = await cacheOrFetch<AccountDto>(
      this.cache,
      this.accountKey(ctx),
      TTL_BY_ENDPOINT.account,
      () =>
        this.client.getAccountByRiotId(
          this.discoveryRegion,
          ctx.submittedRiotId.gameName,
          ctx.submittedRiotId.tagLine,
        ),
      this.now,
    );

    if (isCacheOrFetchFailure(account)) {
      this.logAuthFailure('account', this.discoveryRegion, account.failure);
      if (account.failure.kind === 'not_found') {
        // Requirements 2.4 / 9.2. Returning here is what guarantees no
        // region-resolution/League-V4/Match-V5 call is issued, and `cacheOrFetch`
        // only writes on success, so no partial state was persisted either.
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

    // --- Phase 1.5: platform resolution (Requirement 1) ------------------------
    let resolved: ResolvedRouting;
    if (platformOverride !== undefined && isSupportedPlatform(platformOverride)) {
      // Requirement 2.4: skips the resolver entirely. An unsupported override
      // falls through to normal resolution instead (see `LookupInput`'s doc).
      resolved = { platform: platformOverride, region: regionForPlatform(platformOverride), usedOverride: true };
    } else {
      const resolution = await this.regionResolver.resolve(puuid);
      if (resolution.kind === 'no_lol_account') {
        return { kind: 'error', code: 'NO_LOL_ACCOUNT', retriable: false }; // Requirement 5.2
      }
      if (resolution.kind === 'unsupported_platform') {
        // Requirement 5.3: name the platform Riot reported.
        return { kind: 'error', code: 'UNSUPPORTED_PLATFORM', retriable: false, platform: resolution.platform };
      }
      if (resolution.kind === 'failed') {
        // Requirement 5.4: no guessed fallback — surface the underlying error.
        return this.errorFor('regionResolution', resolution.cause);
      }
      resolved = { platform: resolution.platform, region: resolution.region, usedOverride: false };
    }
    ctx.resolved = resolved;
    const { platform, region } = resolved;

    // --- Phase 2: League-V4 + Match-V5 match-ids (required), Summoner-V4 -------
    // -----------(Enrichment_Call, Requirement 4) --------------------------------
    // The raw result is captured once and awaited twice (settled promises are
    // cheap to re-await): once via `enrich` for the value, once here so an
    // auth failure can still be logged (Requirement 9.5) without Requirement
    // 4.5's "no error code, routing decision, or pipeline-halting condition"
    // ever seeing it.
    const summonerResultPromise = this.client.getSummonerByPuuid(platform, puuid);
    const [league, matchIds, summoner] = await Promise.all([
      cacheOrFetch<LeagueEntryDto[]>(
        this.cache,
        { endpoint: 'league', routingValue: platform, params: { puuid } },
        TTL_BY_ENDPOINT.league,
        () => this.client.getLeagueEntriesByPuuid(platform, puuid), // Requirement 2.3
        this.now,
      ),
      cacheOrFetch<string[]>(
        this.cache,
        { endpoint: 'matchIds', routingValue: region, params: { puuid } },
        TTL_BY_ENDPOINT.matchIds,
        () => this.client.getMatchIdsByPuuid(region, puuid, this.matchHistoryCount), // Requirement 3.1
        this.now,
      ),
      enrich(() => summonerResultPromise),
    ]);
    const summonerResult = await summonerResultPromise;
    if (summonerResult.kind !== 'ok') {
      this.logAuthFailure('summoner', platform, summonerResult);
    }

    // Decision 9 (revised): summoner can no longer fail the pipeline, so only
    // league and match-ids are reported in fixed order; every auth failure is
    // still logged.
    const stages: { stage: LookupStage; outcome: CacheOrFetchOutcome<unknown> }[] = [
      { stage: 'league', outcome: league },
      { stage: 'matchIds', outcome: matchIds },
    ];
    const failures: StageFailure[] = [];
    for (const { stage, outcome } of stages) {
      if (isCacheOrFetchFailure(outcome)) {
        this.logAuthFailure(stage, stage === 'matchIds' ? region : platform, outcome.failure);
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

    // Type narrowing: the loop above proved both succeeded.
    if (isCacheOrFetchFailure(league) || isCacheOrFetchFailure(matchIds)) {
      return { kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true };
    }

    // --- Phase 3: match details (Requirements 3.2, 3.3, 3.5) ------------------
    const window = await this.fetchMatchDetails(region, puuid, matchIds.value, gate);

    const report = await this.assembleReport({
      ctx,
      puuid,
      resolvedPlatform: platform,
      usedPlatformOverride: resolved.usedOverride,
      summoner,
      league: league.value,
      matches: window.matches,
      lanelessMatches: window.lanelessMatches,
      ages: [ageOf(account), ageOf(league), ageOf(matchIds)],
      partialDataWarning: false,
    });

    // specs/database/ Requirement 4.1: unawaited. Only the fresh success path
    // records — never the Requirement 11.3 stale-cache fallback, which returns
    // `kind: 'success'` from `runLookup`, not from here.
    this.recordLookupSideEffects(report);

    return { kind: 'success', report };
  }

  /**
   * specs/database/ Requirement 2/3/4. Records a rank snapshot (Ranked Solo/Duo
   * only) and remembers the player, as unawaited side effects of a successful
   * lookup. Never awaited on the request path (4.1); a store rejection is logged
   * and swallowed, never propagated (4.2); issues no Riot call (4.5).
   */
  private recordLookupSideEffects(report: ProfileReport): void {
    const observedAt = this.now();
    const solo = report.stats.rankedByQueue[SOLO_QUEUE_TYPE]; // Requirement 2.1

    // Requirement 4.2: a store method that throws *synchronously* (rather than
    // returning a rejected promise) must be caught too, or it escapes on the
    // request path — so each call is wrapped.
    const guard = (call: () => Promise<unknown>): Promise<unknown> => {
      try {
        return call();
      } catch (reason) {
        return Promise.reject(reason);
      }
    };

    void Promise.allSettled([
      solo !== undefined && solo !== 'Unranked'
        ? guard(() =>
            this.rankHistoryStore.record({
              puuid: report.puuid,
              queueType: SOLO_QUEUE_TYPE,
              tier: solo.tier,
              division: solo.division,
              leaguePoints: solo.leaguePoints,
              observedAt,
            }),
          )
        : Promise.resolve(), // Requirement 2.4: unranked ⇒ no snapshot
      guard(() =>
        this.lookedUpPlayerStore.remember({
          puuid: report.puuid,
          gameName: report.riotId.gameName,
          tagLine: report.riotId.tagLine,
          profileIconId: report.profileIconId,
          region: report.resolvedPlatform,
          lastLookedUpAt: observedAt,
        }),
      ),
      // autofill-search Requirement 8.1/8.3: the whole report, keyed by PUUID.
      guard(() => this.profileSnapshotStore.save(report.puuid, report, observedAt)),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          this.logger.storeWriteFailed({ reason: result.reason }); // Requirement 4.2
        }
      }
    });
  }

  /**
   * Requirements 3.2/3.3/3.5. Fetches each match detail, excluding — without
   * halting — any match that fails to fetch for ANY reason (including timeout and
   * rate limiting) or whose queue type is not allowed.
   *
   * Bounded in width and length per decision 11, and stops issuing new requests
   * once the budget has elapsed (decision 5).
   *
   * specs/match-cache/ Requirements 3 & 4: before the Riot fan-out, the persistent
   * `MatchStore` is consulted (one batched `getMany`) for every id the in-memory
   * cache does not already hold. A stored match is used directly and seeded into
   * the in-memory cache — no Riot call. Genuinely new matches are fetched as
   * today and then written back to the store (one unawaited bulk `putMany`), so a
   * lookup after a restart, or a Refresh of a returning player, only pays for the
   * matches that are actually new.
   */
  private async fetchMatchDetails(
    region: RegionalRoutingValue,
    puuid: string,
    rawMatchIds: string[],
    gate: BudgetGate,
  ): Promise<MatchHistoryWindow> {
    const matchIds = (Array.isArray(rawMatchIds) ? rawMatchIds : [])
      .filter((matchId): matchId is string => typeof matchId === 'string' && matchId.length > 0)
      .slice(0, this.matchHistoryCount);

    const keyFor = (matchId: string): CacheKey => ({
      endpoint: 'matchDetail',
      routingValue: region,
      params: { matchId },
    });

    // specs/match-cache/ Requirement 3.1 (design open question 2): only ask the
    // store for ids the in-memory cache misses — `matchDetail` entries never go
    // stale, so a present entry is always a usable hit.
    const cacheMissIds: string[] = [];
    for (const matchId of matchIds) {
      if ((await this.readCached<MatchDto>(keyFor(matchId))) === undefined) {
        cacheMissIds.push(matchId);
      }
    }
    // Requirement 3.4: bounded and fail-safe — a failure is indistinguishable
    // from an empty store, and the fan-out falls through to Riot.
    const stored: Map<string, StoredMatch> =
      cacheMissIds.length > 0
        ? await this.matchStore.getMany(cacheMissIds).catch(() => new Map<string, StoredMatch>())
        : new Map();

    const matches: IncludedMatch[] = [];
    const lanelessMatches: LanelessMatch[] = [];
    const fetchedFromRiot: MatchDto[] = [];
    let attemptedCount = 0;

    for (let start = 0; start < matchIds.length; start += this.matchDetailConcurrency) {
      if (gate.expired()) {
        break;
      }
      const batch = matchIds.slice(start, start + this.matchDetailConcurrency);
      attemptedCount += batch.length;

      const outcomes = await Promise.all(
        batch.map(async (matchId): Promise<{ value: MatchDto } | { failure: RiotApiFailure }> => {
          const hit = stored.get(matchId);
          if (hit !== undefined) {
            // Requirement 3.2: seed the in-memory cache so a same-process repeat is instant.
            await this.cache.set(keyFor(matchId), hit.match, TTL_BY_ENDPOINT.matchDetail).catch(() => {});
            return { value: hit.match };
          }
          const outcome = await cacheOrFetch<MatchDto>(
            this.cache,
            keyFor(matchId),
            TTL_BY_ENDPOINT.matchDetail,
            () => this.client.getMatchById(region, matchId), // Requirement 3.2
            this.now,
          );
          if (isCacheOrFetchFailure(outcome)) {
            return { failure: outcome.failure };
          }
          if (!outcome.fromCache) {
            fetchedFromRiot.push(outcome.value); // Requirement 4.1
          }
          return { value: outcome.value };
        }),
      );

      for (const outcome of outcomes) {
        if ('failure' in outcome) {
          // Requirement 3.3: exclude this match, keep going.
          this.logAuthFailure('matchDetail', region, outcome.failure);
          continue;
        }
        // Requirement 3.5 and the mapping module's exclusion rules.
        const included = toIncludedMatch(outcome.value, puuid);
        if (included !== undefined) {
          matches.push(included);
          continue;
        }
        // `match-detail-tabs` Requirement 11.1: a match `toIncludedMatch` excluded
        // (unrecognized queue) may still be a Laneless_Match — tried only after
        // the six-queue path declines it, and never the reverse.
        const laneless = toLanelessMatch(outcome.value, puuid);
        if (laneless !== undefined) {
          lanelessMatches.push(laneless);
        }
      }
    }

    // specs/match-cache/ Requirement 4: fire-and-forget the matches we just pulled
    // from Riot into the store. Fired from HERE, before any later pipeline stage
    // can fail, so a subsequent failure or budget overrun cannot cancel it
    // (Requirement 4.3). A rejection is logged and swallowed (Requirement 4.4).
    if (fetchedFromRiot.length > 0) {
      const observedAt = this.now();
      void (async () => {
        await this.matchStore.putMany(
          fetchedFromRiot.map((match) => ({
            matchId: match.metadata.matchId,
            match,
            region,
            storedAt: observedAt,
          })),
        );
      })().catch((reason: unknown) => this.logger.storeWriteFailed({ reason }));
    }

    return { puuid, matches, lanelessMatches, attemptedCount };
  }

  /**
   * Requirement 11.3's fallback (decision 4). Reads the cache DIRECTLY rather
   * than through `cacheOrFetch`, because it must accept stale entries and must
   * never issue a Riot call — the whole point is that the fresh path already
   * failed or ran out of time.
   *
   * Returns `undefined` when a complete snapshot is not available, which is the
   * signal to report an error instead (Requirements 2.7 / 3.6). "Complete" means
   * the PUUID is known, the platform is resolved, and the league and match-ids
   * entries both exist; individual match details may be missing, which is the
   * same tolerated exclusion Requirement 3.3 defines on the fresh path.
   *
   * Summoner-V4 is deliberately absent from this method entirely: it is an
   * Enrichment_Call that is never written to the cache (see `runPipeline`'s
   * comment on `enrich`), so there is nothing to read here even in principle —
   * every fallback report has `summonerLevel`/`profileIconId` null, which is a
   * substantively true statement (Requirement 4.2 applies uniformly, not only
   * on the fresh path) rather than a limitation of this method.
   */
  private async buildFallbackReport(ctx: LookupContext): Promise<ProfileReport | undefined> {
    const account = ctx.account;
    const resolved = ctx.resolved;
    if (account === undefined || resolved === undefined) {
      // No fallback is possible before the platform is known — Requirement 5.4's
      // "no guessed fallback" holds structurally, not just as a policy choice.
      return undefined;
    }
    const puuid = account.dto.puuid;
    const { platform, region, usedOverride } = resolved;

    const league = await this.readCached<LeagueEntryDto[]>({
      endpoint: 'league',
      routingValue: platform,
      params: { puuid },
    });
    const matchIds = await this.readCached<string[]>({
      endpoint: 'matchIds',
      routingValue: region,
      params: { puuid },
    });

    if (league === undefined || matchIds === undefined) {
      return undefined;
    }

    const ids = (Array.isArray(matchIds.value) ? matchIds.value : [])
      .filter((matchId): matchId is string => typeof matchId === 'string' && matchId.length > 0)
      .slice(0, this.matchHistoryCount);

    // specs/match-cache/ Requirement 3.6: a match absent from the in-memory cache
    // but present in the persistent store still counts, so a fallback assembled
    // after a restart is as complete as one assembled before it. Still no Riot
    // call — a match neither source has is excluded, exactly as today.
    const cacheEntries = new Map<string, MatchDto>();
    const storeMissIds: string[] = [];
    for (const matchId of ids) {
      const entry = await this.readCached<MatchDto>({
        endpoint: 'matchDetail',
        routingValue: region,
        params: { matchId },
      });
      if (entry === undefined) {
        storeMissIds.push(matchId);
      } else {
        cacheEntries.set(matchId, entry.value);
      }
    }
    const stored: Map<string, StoredMatch> =
      storeMissIds.length > 0
        ? await this.matchStore.getMany(storeMissIds).catch(() => new Map<string, StoredMatch>())
        : new Map();

    const matches: IncludedMatch[] = [];
    const lanelessMatches: LanelessMatch[] = [];
    for (const matchId of ids) {
      const match = cacheEntries.get(matchId) ?? stored.get(matchId)?.match;
      if (match === undefined) {
        continue;
      }
      const included = toIncludedMatch(match, puuid);
      if (included !== undefined) {
        matches.push(included);
        continue;
      }
      const laneless = toLanelessMatch(match, puuid);
      if (laneless !== undefined) {
        lanelessMatches.push(laneless);
      }
    }

    return await this.assembleReport({
      ctx,
      puuid,
      resolvedPlatform: platform,
      usedPlatformOverride: usedOverride,
      summoner: null,
      league: league.value,
      matches,
      lanelessMatches,
      ages: [
        account.age,
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

  /**
   * Runs the Insight Engine over the assembled data and builds the report.
   *
   * `async` only because of the `rankHistory` read (profile-sidebar Requirement
   * 10.3): a single indexed lookup against the persistent store, `.catch`ed to
   * `[]` so a slow or unreachable store yields an empty graph rather than a slow
   * or failed lookup. With `MONGODB_URI` unset the no-op store resolves `[]`
   * synchronously, so this adds nothing.
   */
  private async assembleReport(args: {
    ctx: LookupContext;
    puuid: string;
    resolvedPlatform: PlatformRoutingValue;
    usedPlatformOverride: boolean;
    /** Requirement 4.2: `null` exactly when the Enrichment_Call failed. */
    summoner: SummonerDto | null;
    league: LeagueEntryDto[];
    matches: IncludedMatch[];
    /** `match-detail-tabs` Requirement 11.1. Never passed to `computeStats`/`computeFunFacts`/`computeRecommendations`/`averageMatchDurationMinutesOf`. */
    lanelessMatches: LanelessMatch[];
    ages: ComponentAge[];
    partialDataWarning: boolean;
  }): Promise<ProfileReport> {
    const { ctx, puuid, resolvedPlatform, usedPlatformOverride, summoner, matches, lanelessMatches, ages, partialDataWarning } = args;
    // Requirements 2.8 / 6.1: an empty or unreadable entry list is Unranked.
    const league = toLeagueEntries(args.league);

    // profile-sidebar Requirement 7.1 / 8.1: one pass per Queue_Filter_Value over
    // the matching subset (`'all'` is the whole set). `statsByQueue['all']` is
    // therefore exactly today's single-pass `computeStats(matches, league)`, and
    // `stats` is bound to it so nothing that reads `report.stats` changes.
    const statsByQueue = {} as Record<QueueFilterValue, ProfileStats>;
    const rolePerformanceByQueue = {} as Record<QueueFilterValue, RolePerformanceEntry[]>;
    const premadesByQueue = {} as Record<QueueFilterValue, PremadeEntry[]>;
    for (const value of QUEUE_FILTER_VALUES) {
      const subset = value === 'all' ? matches : matches.filter((match) => match.queueType === value);
      statsByQueue[value] = computeStats(subset, league, puuid);
      rolePerformanceByQueue[value] = computeRolePerformance(subset);
      premadesByQueue[value] = computePremades(subset);
    }
    const stats = statsByQueue.all;

    // profile-sidebar Requirement 10.3 + design.md Error Handling: supplementary,
    // never allowed to fail or stall the lookup.
    const rankHistory = await this.rankHistoryStore
      .history(puuid, SOLO_QUEUE_TYPE)
      .catch(() => [] as RankSnapshot[]);

    return {
      riotId: canonicalRiotId(ctx),
      puuid,
      summonerLevel: finiteOrNull(summoner?.summonerLevel), // Requirement 4.2/4.3
      profileIconId: finiteOrNull(summoner?.profileIconId), // see ProfileReport
      resolvedPlatform,
      usedPlatformOverride,
      stats,
      statsByQueue,
      rolePerformanceByQueue,
      premadesByQueue,
      rankHistory,
      funFacts: computeFunFacts(matches), // Requirements 7.1-7.6
      limitedDataNotice: isLimitedData(matches), // Requirements 3.4 / 7.5
      recommendations: computeRecommendations(matches, stats), // Requirements 8.1-8.5
      averageMatchDurationMinutes: averageMatchDurationMinutesOf(matches), // Requirement 7.3
      recentMatches: computeRecentMatches(matches, lanelessMatches),
      lastUpdated: lastUpdatedOf(ages), // Requirements 11.4 / 11.5
      partialDataWarning,
    };
  }

  /**
   * Requirement 9's error table (decisions 2 and 3), revised by
   * lookup-pipeline-fixes.
   *
   * | failure kind  | code                                              | retriable |
   * |---------------|---------------------------------------------------|-----------|
   * | auth_error    | AUTH_FAILURE                             (9.5)    | false     |
   * | timeout       | TIMEOUT                                  (9.4)    | false     |
   * | rate_limited  | RATE_LIMITED                             (9.8)    | true      |
   * | network_error | NETWORK_ERROR                            (9.9)    | true      |
   * | server_error  | MATCH_HISTORY_UNAVAILABLE at matchIds    (3.6),   | true      |
   * |               | RIOT_UNAVAILABLE elsewhere               (9.3)    |           |
   * | not_found     | MATCH_HISTORY_UNAVAILABLE at matchIds    (3.6),   | false     |
   * |               | RIOT_UNAVAILABLE elsewhere                        |           |
   *
   * The former `not_found`-at-summoner row (Requirement 9.10 / Finding A,
   * `PLAYER_NOT_ON_PLATFORM`) is GONE, not merely renamed: Summoner-V4 no longer
   * reaches this method at all (it is an Enrichment_Call, Requirement 4), and the
   * condition it used to detect — a correct Riot ID on the wrong platform — is
   * now caught earlier and more directly by the Region Resolver as
   * `NO_LOL_ACCOUNT` or `UNSUPPORTED_PLATFORM`, handled separately in
   * `runPipeline` before this method is ever called for those cases. This
   * method's callers now are only `account`, `regionResolution`, `league`,
   * `matchIds` and `matchDetail`. League-V4 is deliberately NOT given its own
   * `not_found` row: it returns 200 with an empty array for an unranked player
   * (Requirement 2.8), so a 404 there is an unreadable response, not a
   * meaningful signal.
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

  /**
   * Keyed on the Discovery_Region, which is a fixed configuration value now
   * (Requirement 1.5) rather than a visitor choice — so two visitors looking up
   * the same Riot ID always share one cache entry, where before a different
   * region selection produced a distinct, redundant entry for the same account.
   */
  private accountKey(ctx: LookupContext): CacheKey {
    return {
      endpoint: 'account',
      routingValue: this.discoveryRegion,
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

/**
 * Requirement 4.1/4.4/4.5. Translates an Enrichment_Call's `RiotApiResult` into
 * `T | null` with no error channel at all — there is no failure branch to
 * inspect, which is what makes Requirement 4.5 ("no error code, routing
 * decision, or pipeline-halting condition derives from this call") checkable by
 * looking at this function's return type rather than by auditing every call
 * site that might have branched on it.
 */
async function enrich<T>(fetch: () => Promise<RiotApiResult<T>>): Promise<T | null> {
  const result = await fetch();
  return result.kind === 'ok' ? result.data : null;
}

/**
 * For fields where zero is a MEANINGFUL value rather than a safe default.
 * `finiteOrZero` on `profileIconId` made a missing icon indistinguishable from
 * icon 0, which is a real icon; absent data must read as absent.
 */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function createLookupOrchestrator(options: LookupOrchestratorOptions): LookupOrchestrator {
  return new DefaultLookupOrchestrator(options);
}
