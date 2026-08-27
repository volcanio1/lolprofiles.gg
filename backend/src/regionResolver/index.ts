/**
 * Region Resolver.
 *
 * lookup-pipeline-fixes. Answers "which Platform_Routing_Value does this PUUID's
 * League of Legends account live on", by calling Account-V1's
 * region-by-game-by-puuid endpoint through the generic `cacheOrFetch` helper —
 * the same cache-first machinery every other Riot sub-fetch in this codebase
 * already goes through (Requirement 6.3).
 *
 * Implements:
 *  - 1.1: issues the region-by-game-by-puuid call.
 *  - 1.2/1.3: distinguishes "no LoL account" from "unsupported platform" from
 *    "the call itself failed", as three of `RegionResolution`'s four variants.
 *  - 3.3: normalises the returned platform before reverse-mapping it.
 *  - 5.2: `no_lol_account` is Riot's own signal, not a guess — see decision 1.
 *  - 6.1-6.3: goes through `cacheOrFetch` against the `accountRegion` endpoint,
 *    so a cached resolution issues no Riot call.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. A 404 FROM THIS ENDPOINT IS TREATED AS `no_lol_account`, NOT `failed`.
 *    Task 1.1's live verification confirmed the endpoint's shape and casing but
 *    could not confirm this specific response (see design.md's Testing
 *    Strategy) — no test account with zero League play history was available.
 *    This mapping is written the way Riot's other by-puuid endpoints report "no
 *    record for this game", and is the best-reasoned choice available; it should
 *    be replaced with a confirmed observation the first time a genuine no-League
 *    account can be tested against it.
 *
 * 2. THE DISCOVERY REGION IS FIXED AT CONSTRUCTION, NOT PASSED PER CALL.
 *    Matches design.md's declared `resolve(puuid: string)` signature, which
 *    takes no region argument — the Discovery_Region is a configuration value
 *    (design.md: "any regional host answers them"), so it is closed over once
 *    when the resolver is built rather than threaded through every call site.
 *
 * 3. NORMALISATION HAPPENS BEFORE THE SUPPORTED-PLATFORM CHECK, NOT AFTER.
 *    Requirement 3.4's casing bridge only does anything if it runs before
 *    `isSupportedPlatform`; running it after would mean an uppercase platform
 *    Riot returns is rejected as unsupported before normalisation ever sees it.
 */

import type { CacheStore } from '../cache';
import { TTL_BY_ENDPOINT } from '../cache';
import { cacheOrFetch, isCacheOrFetchFailure, type RiotApiFailure } from '../orchestrator/cacheOrFetch';
import {
  isSupportedPlatform,
  normalisePlatform,
  regionForPlatform,
  type PlatformRoutingValue,
  type RegionalRoutingValue,
} from '../region';
import type { AccountRegionDto, RiotApiClient } from '../riotApiClient';

export type RegionResolution =
  | { kind: 'resolved'; platform: PlatformRoutingValue; region: RegionalRoutingValue }
  | { kind: 'no_lol_account' }
  | { kind: 'unsupported_platform'; platform: string }
  | { kind: 'failed'; cause: RiotApiFailure };

export interface RegionResolver {
  resolve(puuid: string): Promise<RegionResolution>;
}

export interface RegionResolverOptions {
  client: RiotApiClient;
  cache: CacheStore;
  /** Decision 2: fixed once, not a visitor input. */
  discoveryRegion: RegionalRoutingValue;
  now: () => number;
}

class DefaultRegionResolver implements RegionResolver {
  private readonly client: RiotApiClient;
  private readonly cache: CacheStore;
  private readonly discoveryRegion: RegionalRoutingValue;
  private readonly now: () => number;

  constructor(options: RegionResolverOptions) {
    this.client = options.client;
    this.cache = options.cache;
    this.discoveryRegion = options.discoveryRegion;
    this.now = options.now;
  }

  async resolve(puuid: string): Promise<RegionResolution> {
    const outcome = await cacheOrFetch<AccountRegionDto>(
      this.cache,
      { endpoint: 'accountRegion', routingValue: this.discoveryRegion, params: { puuid, game: 'lol' } },
      TTL_BY_ENDPOINT.accountRegion,
      () => this.client.getRegionByPuuid(this.discoveryRegion, 'lol', puuid),
      this.now,
    );

    if (isCacheOrFetchFailure(outcome)) {
      // Decision 1.
      if (outcome.failure.kind === 'not_found') {
        return { kind: 'no_lol_account' };
      }
      return { kind: 'failed', cause: outcome.failure };
    }

    // Decision 3: normalise before checking support.
    const platform = normalisePlatform(outcome.value.region);
    if (!isSupportedPlatform(platform)) {
      return { kind: 'unsupported_platform', platform: outcome.value.region };
    }

    return { kind: 'resolved', platform, region: regionForPlatform(platform) };
  }
}

export function createRegionResolver(options: RegionResolverOptions): RegionResolver {
  return new DefaultRegionResolver(options);
}
