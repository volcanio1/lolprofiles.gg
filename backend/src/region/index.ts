/**
 * Region Router.
 *
 * Pure module: no I/O, no network, no cache, no environment access, no logging.
 *
 * Owns the closed mapping from Requirement 5:
 *  - 5.1: exactly four supported Regional_Routing_Values, nothing outside the set
 *  - 5.2: exactly the listed Platform_Routing_Values per region, nothing outside
 *         the mapping
 *  - 5.3: `platformsFor` is the single source of truth callers (including the
 *         region selector) use to restrict platform choices for a region
 *  - 5.4: a platform that does not belong to the selected region is replaced by
 *         the FIRST platform listed for that region, which is why the order of
 *         each region's array is significant and must not be reordered
 *  - 5.5: rejection of wholly unsupported input is performed by callers via
 *         `isValidRegion` / `isValidPlatform` before `resolvePlatform` is
 *         reached; `resolvePlatform` itself takes an already-narrowed
 *         `RegionalRoutingValue` and therefore has no throwing path.
 */

export type RegionalRoutingValue = 'americas' | 'europe' | 'asia' | 'sea';

export type PlatformRoutingValue =
  | 'na1'
  | 'br1'
  | 'la1'
  | 'la2'
  | 'euw1'
  | 'eun1'
  | 'tr1'
  | 'ru'
  | 'kr'
  | 'jp1'
  | 'oc1';

/**
 * The closed region -> platform mapping. Order within each array is meaningful:
 * the first entry is the fallback platform for that region (Requirement 5.4).
 */
export const REGION_TO_PLATFORMS: Readonly<Record<RegionalRoutingValue, readonly PlatformRoutingValue[]>> = {
  americas: ['na1', 'br1', 'la1', 'la2'],
  europe: ['euw1', 'eun1', 'tr1', 'ru'],
  asia: ['kr', 'jp1'],
  sea: ['oc1'],
};

/** The four supported regional routing values, in mapping order. */
export const SUPPORTED_REGIONS: readonly RegionalRoutingValue[] = Object.keys(
  REGION_TO_PLATFORMS,
) as RegionalRoutingValue[];

/**
 * Requirement 1.6: the Regional_Routing_Value used when a visitor has not
 * selected one. Lives here rather than in the API layer because this module owns
 * region semantics, so there is one source of truth for callers that need to
 * default and for the region selector that must offer the same value first.
 */
export const DEFAULT_REGION: RegionalRoutingValue = 'americas';

/**
 * Type guard for Requirement 5.1. Matching is case-sensitive: the requirement
 * lists the routing values in lowercase, and Riot's routing values are
 * lowercase, so `'AMERICAS'` is not a supported value.
 */
export function isValidRegion(value: string): value is RegionalRoutingValue {
  return Object.prototype.hasOwnProperty.call(REGION_TO_PLATFORMS, value);
}

/** Type guard for Requirement 5.2, used by `resolvePlatform` and by callers. */
export function isValidPlatform(value: string): value is PlatformRoutingValue {
  for (const region of SUPPORTED_REGIONS) {
    if ((REGION_TO_PLATFORMS[region] as readonly string[]).includes(value)) {
      return true;
    }
  }
  return false;
}

/** Requirement 5.3: the exact platform list for a region, in mapping order. */
export function platformsFor(region: RegionalRoutingValue): readonly PlatformRoutingValue[] {
  return REGION_TO_PLATFORMS[region];
}

/**
 * Requirement 5.4: return `requestedPlatform` when (and only when) it belongs
 * to the region's platform list; otherwise fall back to the region's first
 * listed platform. This covers `undefined`, unknown strings, and platforms that
 * are valid but belong to a different region.
 */
export function resolvePlatform(
  region: RegionalRoutingValue,
  requestedPlatform: string | undefined,
): PlatformRoutingValue {
  const platforms = REGION_TO_PLATFORMS[region];
  if (
    requestedPlatform !== undefined &&
    isValidPlatform(requestedPlatform) &&
    platforms.includes(requestedPlatform)
  ) {
    return requestedPlatform;
  }
  return platforms[0];
}

/**
 * lookup-pipeline-fixes: the reverse of `REGION_TO_PLATFORMS`.
 *
 * Built by inverting `REGION_TO_PLATFORMS` at module load, rather than declared
 * as a second literal (Requirement 3.2) — a hand-written second mapping is
 * exactly the kind of thing that drifts the next time a platform is added to
 * one list and not the other. This inversion is a function (not a relation)
 * only because `REGION_TO_PLATFORMS`'s platform lists are pairwise disjoint,
 * which `region/index.property.test.ts`'s existing property already asserts;
 * if that disjointness is ever weakened, this derivation silently stops being
 * total, since a platform in two regions would have the second write win.
 */
export const PLATFORM_TO_REGION: Readonly<Record<PlatformRoutingValue, RegionalRoutingValue>> = (() => {
  const map = {} as Record<PlatformRoutingValue, RegionalRoutingValue>;
  for (const region of SUPPORTED_REGIONS) {
    for (const platform of REGION_TO_PLATFORMS[region]) {
      map[platform] = region;
    }
  }
  return map;
})();

/** Requirement 3.1: the Regional_Routing_Value a Resolved_Platform belongs to. */
export function regionForPlatform(platform: PlatformRoutingValue): RegionalRoutingValue {
  return PLATFORM_TO_REGION[platform];
}

/**
 * Requirement 3.1/3.2. Named distinctly from `isValidPlatform` at the call
 * sites this feature introduces (the Region Resolver), but it is the exact
 * same total check — Requirement 3.2 forbids a second, independently-editable
 * notion of "is this platform supported," and `isValidPlatform` already is
 * that notion.
 */
export const isSupportedPlatform = isValidPlatform;

/**
 * Requirement 3.4: lowercases and trims. Account-V1's region-by-game-by-puuid
 * endpoint was confirmed live (task 1.1, `Doffy#Smile` on `europe`) to already
 * return a lowercase platform value (`"euw1"`) matching `PlatformRoutingValue`'s
 * casing exactly, so this normalisation is defensive rather than currently
 * load-bearing — one observation doesn't prove Riot never returns a different
 * casing for some other shard or account, and normalising costs nothing when
 * the input already matches.
 */
export function normalisePlatform(raw: string): string {
  return raw.trim().toLowerCase();
}
