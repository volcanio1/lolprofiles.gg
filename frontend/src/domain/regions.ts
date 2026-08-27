/**
 * Region/platform mapping table and platform display labels.
 *
 * PURE MODULE. No I/O, no React.
 *
 * lookup-pipeline-fixes: the region and platform SELECTOR this module used to
 * support is gone — the platform is now discovered by the backend's Region
 * Resolver from the Riot ID alone (Requirement 2.1/2.2), so there is nothing
 * left for the visitor to choose. What remains here is display-only:
 * `PLATFORM_LABELS` turns the `resolvedPlatform` a report carries (Requirement
 * 2.3) into a name a player recognizes ("euw1" -> "Europe West (EUW)").
 *
 * `REGION_TO_PLATFORMS`/`SUPPORTED_REGIONS` are kept even though nothing in
 * this workspace uses them for routing anymore, because
 * `frontend/src/domain/parity.test.ts` still guards this table against the
 * backend's authoritative copy (`backend/src/region/index.ts`) — the backend
 * derives its own reverse platform-to-region map from that same table
 * (lookup-pipeline-fixes task 1.2), so a drift here would mean this file no
 * longer describes a set of platforms Riot actually groups the way the backend
 * thinks it does.
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

/** Requirement 5.2's closed mapping (backend/src/region), kept for parity only. */
export const REGION_TO_PLATFORMS: Readonly<Record<RegionalRoutingValue, readonly PlatformRoutingValue[]>> = {
  americas: ['na1', 'br1', 'la1', 'la2'],
  europe: ['euw1', 'eun1', 'tr1', 'ru'],
  asia: ['kr', 'jp1'],
  sea: ['oc1'],
};

/** Kept for the parity guard; not used for any selector anymore. */
export const SUPPORTED_REGIONS: readonly RegionalRoutingValue[] = ['americas', 'europe', 'asia', 'sea'];

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

function isKnownPlatform(value: string): value is PlatformRoutingValue {
  return Object.prototype.hasOwnProperty.call(PLATFORM_LABELS, value);
}

/**
 * Requirement 2.3: a display label for a report's `resolvedPlatform`. Falls
 * back to the raw value uppercased — never empty — for a platform this
 * frontend build predates, the same "degrade, don't hide" approach the rest of
 * this codebase uses for unknown backend values.
 */
export function platformLabel(resolvedPlatform: string): string {
  return isKnownPlatform(resolvedPlatform) ? PLATFORM_LABELS[resolvedPlatform] : resolvedPlatform.toUpperCase();
}
