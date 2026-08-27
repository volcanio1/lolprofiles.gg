/**
 * Local persistence for the trimmed Data Dragon index.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN LEANING ON THE BROWSER CACHE
 * ---------------------------------------------------------------------------
 *
 * Requirement 4.4 asks for the metadata to be retained for no less than 24 hours.
 * Task 1.1 checked what Data Dragon actually sends, and the metadata responses carry
 * `ETag` and `Last-Modified` but NO `Cache-Control`. A browser therefore revalidates
 * them on every page load — usually a cheap 304, but still a network round trip per
 * load, and nothing at all when the visitor is offline. Leaning on the HTTP cache
 * would not satisfy the requirement; it would only make missing it inexpensive.
 *
 * Persisting the trimmed index does satisfy it, and costs roughly 55 KB rather than
 * the 846 KB the raw files occupy.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. EVERY ACCESS IS WRAPPED. `localStorage` throws rather than returning null in
 *    several real situations — Safari private browsing, storage disabled by policy,
 *    and a quota exception on write. A thrown error here would take down a report
 *    that Requirement 5.2 says must render in full, so both paths degrade to "no
 *    persisted index" and the metadata is simply re-fetched.
 *
 * 2. THE ENTRY IS KEYED BY VERSION AND CHECKED AGAIN ON READ. A version bump must
 *    not serve the previous release's filenames, and the provider independently
 *    discards a mismatched index, so the check is made twice on purpose: here, so
 *    the stale bytes are evicted rather than re-read every load.
 */

import type { StaticDataIndex } from './provider';

/**
 * Bumped v1 -> v2 when `match-detail-tabs` added spells, runes, rune trees and
 * stat shards to `StaticDataIndex` (task 1.4), then v2 -> v3 when the same
 * feature added augments (task 9.4). Each time, an older entry lacks the new
 * map but would otherwise still validate by shape and match the pinned
 * version — passing `isWellShapedIndex` and serving as "ready" while the new
 * asset class resolves to a placeholder for a full 24-hour retention period,
 * indistinguishable from a genuine CDN failure. The version bump forces every
 * older entry to miss and refetch.
 */
const STORAGE_KEY = 'lolprofiles.staticData.v3';

/** Requirement 4.4 — "no less than 24 hours". */
export const STATIC_DATA_TTL_MS = 24 * 60 * 60 * 1000;

interface StoredEntry {
  version: string;
  storedAt: number;
  index: StaticDataIndex;
}

/**
 * Validates the persisted index's SHAPE, not merely its type.
 *
 * Checking only `typeof index === 'object'` admitted an entry missing `champions`
 * or `items` entirely, which the provider then accepted (its version matched) and
 * dereferenced during render — a `TypeError` thrown inside React, in a tree that
 * deliberately has no error boundary, blanking a report that Requirement 5.2 says
 * must stay readable. The quieter half was worse: a shapeless-but-accepted entry
 * short-circuits the CDN fetch, so the site serves nothing but placeholders for a
 * full 24 hours with no path to recovery.
 *
 * `writeStoredIndex` always writes a well-formed index, so this is reachable only
 * through tampered storage or a future change to `StaticDataIndex` that forgets to
 * bump `STORAGE_KEY`. Nothing enforces that coupling, and the blast radius is the
 * whole page, so the entry is validated on the way in.
 */
function isWellShapedIndex(candidate: unknown, version: string): candidate is StaticDataIndex {
  const index = candidate as StaticDataIndex | null;
  return (
    index !== null &&
    typeof index === 'object' &&
    index.version === version &&
    index.champions !== null &&
    typeof index.champions === 'object' &&
    index.items !== null &&
    typeof index.items === 'object' &&
    index.spells !== null &&
    typeof index.spells === 'object' &&
    index.runes !== null &&
    typeof index.runes === 'object' &&
    index.runeTrees !== null &&
    typeof index.runeTrees === 'object' &&
    index.augments !== null &&
    typeof index.augments === 'object'
  );
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null; // decision 1
  }
}

/**
 * Returns the persisted index when it exists, matches `version`, and is inside the
 * TTL. Returns `null` in every other case, including a corrupt or unreadable entry.
 */
export function readStoredIndex(version: string, now: number): StaticDataIndex | null {
  const store = storage();
  if (store === null) {
    return null;
  }

  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return null; // decision 1
  }
  if (raw === null) {
    return null;
  }

  let entry: StoredEntry;
  try {
    entry = JSON.parse(raw) as StoredEntry;
  } catch {
    clearStoredIndex();
    return null;
  }

  if (
    entry === null ||
    typeof entry !== 'object' ||
    entry.version !== version || // decision 2
    typeof entry.storedAt !== 'number' ||
    !Number.isFinite(entry.storedAt) ||
    !isWellShapedIndex(entry.index, version)
  ) {
    clearStoredIndex();
    return null;
  }

  // `>` rather than `>=`: Requirement 4.4 says "no less than 24 hours", and
  // evicting AT the boundary would cap retention one millisecond short of it.
  if (now - entry.storedAt > STATIC_DATA_TTL_MS) {
    clearStoredIndex();
    return null;
  }

  return entry.index;
}

/** Persists the index. A failure is swallowed: the index is still usable in memory. */
export function writeStoredIndex(index: StaticDataIndex, now: number): void {
  const store = storage();
  if (store === null) {
    return;
  }
  const entry: StoredEntry = { version: index.version, storedAt: now, index };
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // Quota exceeded, or storage disabled mid-session. Nothing to do and nothing
    // worth failing over: the in-memory index still serves this page load.
  }
}

export function clearStoredIndex(): void {
  const store = storage();
  if (store === null) {
    return;
  }
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // See decision 1.
  }
}
