/**
 * Resolves Riot identifiers into Data Dragon asset URLs and display names.
 *
 * PURE: this module holds no state, performs no I/O, and reads no environment. The
 * fetching and persistence live in `StaticDataProvider.tsx`; everything here is a
 * function of its arguments, which is what makes the totality guarantee below
 * testable without a browser or a network.
 *
 * ---------------------------------------------------------------------------
 * THE TOTALITY GUARANTEE
 * ---------------------------------------------------------------------------
 *
 * Every accessor returns a URL or `null`, or a name or a documented fallback. None
 * throws, none returns an empty string where a URL was expected, and none can
 * produce a URL containing `undefined`, `null` or an unresolved version — before or
 * after the index has loaded (Requirements 5.3, 5.4).
 *
 * This matters more than it looks. A URL containing the literal `undefined` renders
 * as a broken image rather than as an error, so nothing in the application would
 * catch it and the visitor sees a torn page. Returning `null` instead routes the
 * call site to `AssetPlaceholder`, which reserves the box and says what is missing.
 *
 * ---------------------------------------------------------------------------
 * WHY SOME ACCESSORS WORK BEFORE THE INDEX LOADS AND OTHERS DO NOT
 * ---------------------------------------------------------------------------
 *
 * `profileIconUrl` needs only the version, because a profile icon's filename IS its
 * identifier. It therefore resolves as soon as the version is known, and a visitor
 * sees their avatar without waiting on 846 KB of metadata.
 *
 * `championIconUrl` needs the index, because the filename comes from the entry's
 * `image.full` rather than being constructed from the key. Task 1.1 confirmed the
 * two agree today (`MonkeyKing` → `MonkeyKing.png`); reading the metadata removes
 * the assumption that they always will.
 *
 * `itemIconUrl` needs the index too, but for a different reason: an item id's
 * filename is `{id}.png`, so the URL is constructible without metadata — but an id
 * absent from the pinned release must resolve to a placeholder rather than to a
 * 404ing image (Requirement 5.4), and membership is only knowable from the index.
 */

export const DDRAGON_BASE = 'https://ddragon.leagueoflegends.com';

/** One champion, trimmed to what rendering needs. */
export interface ChampionEntry {
  /** Display name, e.g. `Wukong` for the key `MonkeyKing`. */
  name: string;
  /** Image filename from the metadata's `image.full`, e.g. `MonkeyKing.png`. */
  image: string;
}

/** One item, trimmed to what rendering needs. */
export interface ItemEntry {
  name: string;
  image: string;
  /** Precomputed at index time; see `classifyCompletedItem`. */
  completed: boolean;
}

/**
 * The trimmed, persisted form of Data Dragon's metadata.
 *
 * `champion.json` and `item.json` are 159 KB and 687 KB respectively. Almost all of
 * that is descriptions, stats, tags and build trees the renderer never reads, so
 * the raw files are indexed down to roughly 55 KB before being persisted — which is
 * what makes storing them locally reasonable rather than abusive.
 */
export interface StaticDataIndex {
  version: string;
  /** Keyed by Champion_Key, e.g. `MonkeyKing`. */
  champions: Record<string, ChampionEntry>;
  /** Keyed by the item id as a string. */
  items: Record<string, ItemEntry>;
}

export interface StaticDataProvider {
  /** True once the index is available. Accessors are safe either way. */
  readonly ready: boolean;
  /** The pinned version, or `null` before `GET /api/static-data` has answered. */
  readonly version: string | null;
  /** Display name for a Champion_Key; the key itself when unresolvable. */
  championDisplayName(key: string): string;
  championIconUrl(key: string): string | null;
  /** `0` is a REAL icon (verified 200), so only `null` means absent. */
  profileIconUrl(id: number | null): string | null;
  /** `0` is an EMPTY SLOT, never an item, so it resolves to `null`. */
  itemIconUrl(id: number): string | null;
  /** Item name; the identifier as a string when unresolvable. */
  itemDisplayName(id: number): string;
  /** Serves `item-timeline`'s Requirement 3.2. False when unresolvable. */
  isCompletedItem(id: number): boolean;
}

/**
 * A usable identifier is a finite, non-negative, exactly-representable integer.
 *
 * The upper bound is not decoration: at 1e21 and above JavaScript stringifies a
 * number in exponential form, so a naive interpolation yields `.../1e+21.png` — a
 * well-formed URL that can never resolve.
 */
function isUsableId(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

/**
 * Own-property lookup into an index map.
 *
 * `champions` and `items` are plain objects, so they inherit `Object.prototype` and
 * a bare `map[key]` resolves inherited members: `champions['constructor']` is the
 * `Object` constructor, not `undefined`. A `!== undefined` guard therefore ADMITS
 * `constructor`, `toString`, `valueOf`, `__proto__` and friends, after which
 * `entry.image` is `undefined` and the URL ends in the literal string "undefined" —
 * the exact failure this module's totality guarantee exists to rule out, and one
 * that renders as a broken image rather than as an error.
 *
 * The shape check is the second half: a persisted index that has been corrupted or
 * written by an older build can hold entries that are not entries. Validating at
 * the point of use keeps every accessor total regardless of what reached the map.
 */
function lookupEntry<T extends object>(
  map: Record<string, T> | undefined,
  key: string,
  isValid: (candidate: unknown) => candidate is T,
): T | undefined {
  if (map === undefined || map === null || typeof map !== 'object') {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(map, key)) {
    return undefined;
  }
  const candidate = (map as Record<string, unknown>)[key];
  return isValid(candidate) ? candidate : undefined;
}

function isChampionEntry(candidate: unknown): candidate is ChampionEntry {
  const entry = candidate as ChampionEntry | null;
  return (
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.name === 'string' &&
    typeof entry.image === 'string'
  );
}

function isItemEntry(candidate: unknown): candidate is ItemEntry {
  const entry = candidate as ItemEntry | null;
  return (
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.name === 'string' &&
    typeof entry.image === 'string'
  );
}

/**
 * Component versus completed item, verified against live metadata in task 1.1.
 *
 * The two obvious rules are both wrong. `depth` is absent on 520 of 868 entries,
 * including Doran's Blade, which is a finished item. "Has no `into`" excludes
 * Berserker's Greaves, which builds into tier-3 boots but is unquestionably an item
 * a player completes and uses for most of the game.
 *
 * This composite resolves every representative case correctly: Doran's Blade,
 * Infinity Edge, Blade of the Ruined King and Berserker's Greaves are completed;
 * Long Sword, B.F. Sword, tier-1 Boots, Health Potion, Control Ward and Warding
 * Totem are not.
 */
export function classifyCompletedItem(raw: {
  tags?: readonly string[];
  gold?: { total?: number };
  depth?: number;
  into?: readonly string[];
}): boolean {
  // `??` guards only null/undefined, so a non-array `tags` from malformed metadata
  // would throw inside `new Set(...)` and abort the whole index build.
  const tags = new Set(Array.isArray(raw.tags) ? raw.tags : []);
  if (tags.has('Consumable') || tags.has('Trinket')) {
    return false;
  }
  if (!raw.gold || typeof raw.gold.total !== 'number' || raw.gold.total <= 0) {
    return false;
  }
  if ((raw.depth ?? 0) >= 2) {
    return true; // built from components
  }
  // Standalone finished item. An `into` that is present but EMPTY builds into
  // nothing, so it is completed too — `!raw.into` alone would misread `[]` as a
  // component, since an empty array is truthy.
  return !Array.isArray(raw.into) || raw.into.length === 0;
}

/** Builds the trimmed index from Data Dragon's raw metadata. Never throws. */
export function buildStaticDataIndex(
  version: string,
  championJson: unknown,
  itemJson: unknown,
): StaticDataIndex {
  const champions: Record<string, ChampionEntry> = {};
  const items: Record<string, ItemEntry> = {};

  const championData = (championJson as { data?: Record<string, unknown> } | null)?.data;
  if (championData && typeof championData === 'object') {
    for (const [key, value] of Object.entries(championData)) {
      const entry = value as { name?: unknown; image?: { full?: unknown } };
      const name = typeof entry?.name === 'string' ? entry.name : key;
      const image = typeof entry?.image?.full === 'string' ? entry.image.full : `${key}.png`;
      champions[key] = { name, image };
    }
  }

  const itemData = (itemJson as { data?: Record<string, unknown> } | null)?.data;
  if (itemData && typeof itemData === 'object') {
    for (const [id, value] of Object.entries(itemData)) {
      const entry = value as {
        name?: unknown;
        image?: { full?: unknown };
        tags?: readonly string[];
        gold?: { total?: number };
        depth?: number;
        into?: readonly string[];
      };
      const name = typeof entry?.name === 'string' ? entry.name : id;
      const image = typeof entry?.image?.full === 'string' ? entry.image.full : `${id}.png`;
      items[id] = { name, image, completed: classifyCompletedItem(entry ?? {}) };
    }
  }

  return { version, champions, items };
}

/**
 * Builds a provider over a version and an optional index.
 *
 * Both arguments are nullable on purpose: the provider exists and answers from the
 * first render, long before `GET /api/static-data` has replied, and the report must
 * render in full throughout (Requirement 5.2).
 */
export function createStaticDataProvider(
  version: string | null,
  index: StaticDataIndex | null,
): StaticDataProvider {
  // An index for a different version is not this version's index. Ignoring it here
  // means a stale persisted entry can never leak assets from the wrong release.
  const usable = index !== null && version !== null && index.version === version ? index : null;
  const base = version === null ? null : `${DDRAGON_BASE}/cdn/${encodeURIComponent(version)}`;

  return {
    ready: usable !== null,
    version,

    championDisplayName(key: string): string {
      // Requirements 6.1/6.2 want a NON-EMPTY text alternative. A non-string key
      // can still arrive from untyped JSON, and returning '' there would produce an
      // unlabeled image, so it is stringified rather than discarded.
      if (typeof key !== 'string') {
        return String(key);
      }
      // Requirement 1.4: the raw key is the fallback, so a champion released after
      // the pinned release still reads as something rather than as nothing.
      return lookupEntry(usable?.champions, key, isChampionEntry)?.name ?? key;
    },

    championIconUrl(key: string): string | null {
      if (base === null || usable === null || typeof key !== 'string' || key.length === 0) {
        return null;
      }
      const entry = lookupEntry(usable.champions, key, isChampionEntry);
      if (entry === undefined) {
        return null;
      }
      return `${base}/img/champion/${encodeURIComponent(entry.image)}`;
    },

    profileIconUrl(id: number | null): string | null {
      // Deliberately NOT gated on the index: a profile icon's filename is its own
      // identifier, so this resolves as soon as the version is known. `0` is a real
      // icon (task 1.1 verified a 200), so only `null` means absent.
      if (base === null || id === null || !isUsableId(id)) {
        return null;
      }
      return `${base}/img/profileicon/${id}.png`;
    },

    itemIconUrl(id: number): string | null {
      // `0` is the encoding for an empty inventory slot, never an item. Requesting
      // it 403s at the CDN (task 1.1), which is exactly what this prevents.
      if (base === null || usable === null || !isUsableId(id) || id === 0) {
        return null;
      }
      const entry = lookupEntry(usable.items, String(id), isItemEntry);
      if (entry === undefined) {
        return null;
      }
      return `${base}/img/item/${encodeURIComponent(entry.image)}`;
    },

    itemDisplayName(id: number): string {
      // Requirement 6.3: the identifier is the fallback, so an item removed from
      // the game since the pinned release still has a text alternative.
      if (!isUsableId(id)) {
        // `String()` on a null-prototype object throws, so it is not used blindly.
        try {
          return String(id);
        } catch {
          return '';
        }
      }
      return lookupEntry(usable?.items, String(id), isItemEntry)?.name ?? String(id);
    },

    isCompletedItem(id: number): boolean {
      if (usable === null || !isUsableId(id)) {
        return false;
      }
      return lookupEntry(usable.items, String(id), isItemEntry)?.completed === true;
    },
  };
}
