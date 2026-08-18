/**
 * Region and platform choices for the selector.
 *
 * PURE MODULE. No I/O, no React.
 *
 * Implements:
 *  - 1.6: `DEFAULT_REGION` is `americas`, used when the visitor has not chosen.
 *  - 1.7: the selector offers exactly `americas`, `europe`, `asia`, `sea`.
 *  - 5.3: the platform choices offered for a region are exactly that region's
 *    members, so the UI cannot construct a (region, platform) pair the backend
 *    would have to correct under Requirement 5.4.
 *
 * Mirrors `backend/src/region` for the same reason `riotId.ts` mirrors the
 * backend validator: the workspaces share no code, and the selector cannot be
 * built without the mapping. The backend remains authoritative — it re-validates
 * the region (rejecting anything outside the set) and substitutes a mismatched
 * platform — so a drift here degrades the UI's choices but cannot produce an
 * incorrect lookup. Order within each region is significant: the first entry is
 * the platform the backend falls back to (Requirement 5.4), which is why the
 * "any platform in this region" option is presented as the default.
 *
 * The display labels are UI text and have no counterpart in the backend; the
 * routing values are what travel over the wire.
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

/** Requirement 5.2's closed mapping; first entry per region is the fallback. */
export const REGION_TO_PLATFORMS: Readonly<Record<RegionalRoutingValue, readonly PlatformRoutingValue[]>> = {
  americas: ['na1', 'br1', 'la1', 'la2'],
  europe: ['euw1', 'eun1', 'tr1', 'ru'],
  asia: ['kr', 'jp1'],
  sea: ['oc1'],
};

/** Requirement 1.7: exactly these four, in mapping order. */
export const SUPPORTED_REGIONS: readonly RegionalRoutingValue[] = ['americas', 'europe', 'asia', 'sea'];

/** Requirement 1.6. */
export const DEFAULT_REGION: RegionalRoutingValue = 'americas';

/** Human-readable region names for the selector. */
export const REGION_LABELS: Readonly<Record<RegionalRoutingValue, string>> = {
  americas: 'Americas',
  europe: 'Europe',
  asia: 'Asia',
  sea: 'Southeast Asia & Oceania',
};

/** Human-readable platform names, so `euw1` reads as something a player knows. */
export const PLATFORM_LABELS: Readonly<Record<PlatformRoutingValue, string>> = {
  na1: 'North America (NA)',
  br1: 'Brazil (BR)',
  la1: 'Latin America North (LAN)',
  la2: 'Latin America South (LAS)',
  euw1: 'Europe West (EUW)',
  eun1: 'Europe Nordic & East (EUNE)',
  tr1: 'Türkiye (TR)',
  ru: 'Russia (RU)',
  kr: 'Korea (KR)',
  jp1: 'Japan (JP)',
  oc1: 'Oceania (OCE)',
};

export function isValidRegion(value: string): value is RegionalRoutingValue {
  return Object.prototype.hasOwnProperty.call(REGION_TO_PLATFORMS, value);
}

/** Requirement 5.3: exactly the platforms belonging to `region`, in order. */
export function platformsFor(region: RegionalRoutingValue): readonly PlatformRoutingValue[] {
  return REGION_TO_PLATFORMS[region];
}

/** True when `platform` belongs to `region`, used to reset a stale selection. */
export function platformBelongsTo(region: RegionalRoutingValue, platform: string): boolean {
  return (REGION_TO_PLATFORMS[region] as readonly string[]).includes(platform);
}

/** Narrows an untrusted string (e.g. from a URL) to a region, or the default. */
export function regionFromParam(raw: string | null | undefined): RegionalRoutingValue {
  if (typeof raw === 'string' && isValidRegion(raw)) {
    return raw;
  }
  return DEFAULT_REGION;
}
