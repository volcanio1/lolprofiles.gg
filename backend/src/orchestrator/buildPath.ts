/**
 * Build Path Orchestrator (`item-timeline` feature).
 *
 * Coordinates one `GET /api/match/:matchId/build-path` request: resolve the Riot
 * ID to a PUUID, serve a cached Timeline_Slice if one exists, and otherwise
 * fetch the Match_Timeline once (through the parse gate), replay the analyzed
 * player's shop events, reconcile the result against the already-cached match
 * detail, DISCARD the raw timeline, and cache the kilobyte-sized slice.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. THE REGION COMES FROM THE MATCH ID, NOT A RESOLVER CALL. A match id is
 *    `{PLATFORM}_{gameId}` (`EUW1_7231636281`), so `PLATFORM_TO_REGION` gives the
 *    regional host directly (Requirement 1.2). No Region_Resolver round trip. An
 *    unparseable prefix is a malformed request — `VALIDATION_FAILED`, 400 — not a
 *    Riot outage.
 *
 * 2. THE RAW TIMELINE IS NEVER CACHED, ONLY THE SLICE. The `getMatchTimeline`
 *    response (0.3-1 MB, and up) is parsed inside the parse gate, reduced to a
 *    `TimelineSlice` of a few kilobytes, and dropped. There is no `timeline`
 *    cache endpoint to write it to (item-timeline Requirement 5.1). The slice is
 *    retained indefinitely, by the same immutability argument as `matchDetail`.
 *
 * 3. A MISSING TIMELINE IS `unavailable`, NOT AN ERROR (Requirement 1.5 / 6.1).
 *    Match-V5 has no timeline for some old or aborted matches; that is a normal
 *    outcome, so the route returns 200 with `{ kind: 'unavailable' }` and the
 *    match row keeps rendering its Final_Build. `participant_absent` (the PUUID is
 *    not in `info.participants`) is the same shape — never a partial or empty
 *    build path (Requirement 6.2). Neither is cached: a `not_found` never reaches
 *    `cache.set`, and `participant_absent` returns before it.
 *
 * 4. RECONCILIATION READS THE MATCH DETAIL FROM THE CACHE, FETCHING ONCE ON A
 *    MISS. The build-path tab is opened from a match row a Profile_Report already
 *    populated, so the detail is almost always a cache hit. On the rare miss
 *    (someone hitting the endpoint without loading the profile first) it is
 *    fetched via `getMatchById` and cached indefinitely — returning an
 *    unverified `reconciled: false` for want of one Riot call would be worse.
 *    The slice is `reconciled: false` only when the detail genuinely cannot be
 *    obtained, or carries no row for this player. The replay is still returned;
 *    Requirement 4.5 forbids discarding it.
 *
 * 5. THE CACHE READ/WRITE IS BEST-EFFORT, matching `cacheOrFetch`'s decisions 3
 *    and 8: a read that throws degrades to a miss (a fresh fetch is
 *    correct-but-slower), and a write that throws is swallowed (the slice was
 *    computed successfully, so the request succeeds regardless of cache health).
 */

import { DEFAULT_REGION, PLATFORM_TO_REGION, isValidPlatform, type RegionalRoutingValue } from '../region';
import { TTL_BY_ENDPOINT, type CacheStore } from '../cache';
import type { AccountDto, MatchDto, RiotApiClient } from '../riotApiClient';
import type { ErrorCode } from './index';
import { cacheOrFetch, isCacheOrFetchFailure, type RiotApiFailure } from './cacheOrFetch';
import { itemBuildOf } from './mapping';
import { createParseGate, type ParseGate } from './parseGate';
import { extractSkillOrder, reconcile, replayShopEvents, type TimelineSlice } from '../insight/buildPath';
import type { RiotIdParts } from '../validator';

export type BuildPathResult =
  | { kind: 'build_path'; slice: TimelineSlice }
  | { kind: 'unavailable'; reason: 'no_timeline' | 'participant_absent' }
  | { kind: 'error'; code: ErrorCode; retriable: boolean };

export interface BuildPathOrchestrator {
  getBuildPath(matchId: string, riotId: RiotIdParts): Promise<BuildPathResult>;
}

/**
 * Requirement 4.4's server-side logging seam. Called only when a replay was
 * compared against a Final_Build and the two disagreed — not when the match
 * detail was simply missing from the cache. The point is task 10.1: the
 * disagreements are the only honest source of information about item behaviours
 * this design does not yet model, so they must be visible in real data rather
 * than guessed at now. Carries no PII: match ids and item ids only.
 */
export interface BuildPathLogger {
  unreconciled(info: {
    matchId: string;
    puuid: string;
    /** Item ids the Final_Build reports that the replay did not produce. */
    missingFromReplay: readonly number[];
    /** Item ids the replay produced that the Final_Build does not report. */
    unexpectedInReplay: readonly number[];
  }): void;
}

export const consoleBuildPathLogger: BuildPathLogger = {
  unreconciled({ matchId, missingFromReplay, unexpectedInReplay }) {
    // eslint-disable-next-line no-console
    console.warn(
      `[lolprofiles] build-path replay did not reconcile for match ${matchId}: ` +
        `missing from replay [${missingFromReplay.join(', ')}], ` +
        `unexpected in replay [${unexpectedInReplay.join(', ')}].`,
    );
  },
};

export interface BuildPathOrchestratorOptions {
  cache: CacheStore;
  riotApiClient: RiotApiClient;
  /** Injected clock. Must be the SAME function the cache store was given. */
  now?: () => number;
  /** Bounds concurrent timeline parses (Requirement 1.4). Defaults to `createParseGate()`. */
  parseGate?: ParseGate;
  /**
   * The Discovery_Region for the Account-V1 call, which any regional host answers
   * (design.md). A configuration value, not a visitor input. Defaults to
   * `DEFAULT_REGION`.
   */
  discoveryRegion?: RegionalRoutingValue;
  /** Requirement 4.4 sink; defaults to `consoleBuildPathLogger`. */
  logger?: BuildPathLogger;
}

/** design.md's error table for a failed Riot call under this feature. */
function errorForFailure(failure: RiotApiFailure): { code: ErrorCode; retriable: boolean } {
  switch (failure.kind) {
    case 'auth_error':
      return { code: 'AUTH_FAILURE', retriable: false };
    case 'timeout':
      return { code: 'TIMEOUT', retriable: false };
    case 'rate_limited':
      return { code: 'RATE_LIMITED', retriable: true };
    case 'network_error':
      return { code: 'NETWORK_ERROR', retriable: true };
    case 'server_error':
      return { code: 'RIOT_UNAVAILABLE', retriable: true };
    case 'not_found':
      // Intercepted before this for the timeline call (-> `no_timeline`) and the
      // account call (-> `PLAYER_NOT_FOUND`); kept total.
      return { code: 'RIOT_UNAVAILABLE', retriable: false };
  }
}

/** Platform prefix of `{PLATFORM}_{gameId}`, lowercased, or `undefined` if unrecognised. */
function regionFromMatchId(matchId: string): RegionalRoutingValue | undefined {
  const prefix = matchId.split('_', 1)[0]?.toLowerCase() ?? '';
  return isValidPlatform(prefix) ? PLATFORM_TO_REGION[prefix] : undefined;
}

class DefaultBuildPathOrchestrator implements BuildPathOrchestrator {
  private readonly cache: CacheStore;
  private readonly client: RiotApiClient;
  private readonly now: () => number;
  private readonly parseGate: ParseGate;
  private readonly discoveryRegion: RegionalRoutingValue;
  private readonly logger: BuildPathLogger;

  constructor(options: BuildPathOrchestratorOptions) {
    this.cache = options.cache;
    this.client = options.riotApiClient;
    this.now = options.now ?? Date.now;
    this.parseGate = options.parseGate ?? createParseGate();
    this.discoveryRegion = options.discoveryRegion ?? DEFAULT_REGION;
    this.logger = options.logger ?? consoleBuildPathLogger;
  }

  async getBuildPath(matchId: string, riotId: RiotIdParts): Promise<BuildPathResult> {
    // Requirement 1.2: region from the match id prefix, no resolver call.
    const region = regionFromMatchId(matchId);
    if (region === undefined) {
      return { kind: 'error', code: 'VALIDATION_FAILED', retriable: false };
    }

    // Resolve the Riot ID to a PUUID through the existing cached account path.
    const account = await cacheOrFetch<AccountDto>(
      this.cache,
      {
        endpoint: 'account',
        routingValue: this.discoveryRegion,
        params: { gameName: riotId.gameName, tagLine: riotId.tagLine },
      },
      TTL_BY_ENDPOINT.account,
      () => this.client.getAccountByRiotId(this.discoveryRegion, riotId.gameName, riotId.tagLine),
      this.now,
    );

    if (isCacheOrFetchFailure(account)) {
      if (account.failure.kind === 'not_found') {
        return { kind: 'error', code: 'PLAYER_NOT_FOUND', retriable: false };
      }
      return { kind: 'error', ...errorForFailure(account.failure) };
    }

    const puuid = typeof account.value?.puuid === 'string' ? account.value.puuid : '';
    if (puuid === '') {
      return { kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true };
    }

    // Requirement 5.5: a cached slice is served without any Riot call.
    const sliceKey = { endpoint: 'timelineSlice' as const, routingValue: region, params: { matchId, puuid } };
    try {
      const cached = await this.cache.get<TimelineSlice>(sliceKey);
      if (cached !== undefined) {
        return { kind: 'build_path', slice: cached.value };
      }
    } catch {
      // Decision 5: a failed read is a miss.
    }

    // Miss: one timeline fetch, gated so concurrent parses stay bounded (1.4).
    const timeline = await this.parseGate.run(() => this.client.getMatchTimeline(region, matchId));

    if (timeline.kind !== 'ok') {
      if (timeline.kind === 'not_found') {
        return { kind: 'unavailable', reason: 'no_timeline' }; // Requirement 1.5
      }
      return { kind: 'error', ...errorForFailure(timeline) };
    }

    // Requirement 2.5: the slot comes from the timeline's own participant array.
    const slot = timeline.data.info.participants.find((p) => p.puuid === puuid)?.participantId;
    if (typeof slot !== 'number') {
      return { kind: 'unavailable', reason: 'participant_absent' }; // Requirement 6.2
    }

    const events = timeline.data.info.frames.flatMap((frame) => frame.events);
    const replay = replayShopEvents(events, slot);
    const skillOrder = extractSkillOrder(events, slot);

    // Decision 4: reconcile against the cached match detail; never fetch one.
    const finalBuild = await this.finalBuildFor(region, matchId, puuid);
    let reconciled = false;
    if (finalBuild !== undefined) {
      const outcome = reconcile(replay.finalInventory, finalBuild);
      reconciled = outcome.reconciled;
      if (!outcome.reconciled) {
        // Requirement 4.4: the replay was compared and disagreed. Log the diff so
        // unmodelled item behaviours surface in real data (task 10.1). A missing
        // detail is not logged here — that is a cache gap, not a disagreement.
        this.logger.unreconciled({
          matchId,
          puuid,
          missingFromReplay: outcome.missingFromReplay ?? [],
          unexpectedInReplay: outcome.unexpectedInReplay ?? [],
        });
      }
    }

    const slice: TimelineSlice = { matchId, puuid, buildPath: replay.buildPath, skillOrder, reconciled };

    // The raw timeline is dropped here — `timeline.data` goes out of scope
    // unreferenced and is never written to the cache (Requirement 5.1 / 5.2).
    try {
      await this.cache.set(sliceKey, slice, TTL_BY_ENDPOINT.timelineSlice);
    } catch {
      // Decision 5: a failed write is swallowed.
    }

    return { kind: 'build_path', slice };
  }

  /**
   * The analyzed player's Final_Build, for Reconciliation. Reads the match detail
   * from the cache — almost always a hit, since the build-path tab is opened from
   * a match row a Profile_Report already populated — and fetches it once (caching
   * indefinitely) on the rare miss, rather than returning an unverified result.
   * `undefined` only when the match detail cannot be obtained at all, or carries
   * no row for this player.
   */
  private async finalBuildFor(
    region: RegionalRoutingValue,
    matchId: string,
    puuid: string,
  ): Promise<ReturnType<typeof itemBuildOf> | undefined> {
    const detail = await cacheOrFetch<MatchDto>(
      this.cache,
      { endpoint: 'matchDetail', routingValue: region, params: { matchId } },
      TTL_BY_ENDPOINT.matchDetail,
      () => this.client.getMatchById(region, matchId),
      this.now,
    );
    if (isCacheOrFetchFailure(detail)) {
      return undefined;
    }
    const participant = detail.value.info.participants.find((p) => p.puuid === puuid);
    return participant === undefined ? undefined : itemBuildOf(participant);
  }
}

export function createBuildPathOrchestrator(
  options: BuildPathOrchestratorOptions,
): BuildPathOrchestrator {
  return new DefaultBuildPathOrchestrator(options);
}
