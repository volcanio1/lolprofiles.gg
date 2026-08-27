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

/**
 * Requirement 7.4. Rune, rune tree, and stat shard images 403 on the versioned
 * path — verified live against the pinned version (design.md task 1.1). This is
 * the sole exception to `visual-assets` Requirement 4.1's version pinning; only
 * the image bytes float, never the identifier-to-path mapping (`runesReforged.json`
 * itself is still fetched from the versioned path).
 */
export const DDRAGON_UNVERSIONED_IMG_BASE = `${DDRAGON_BASE}/cdn/img`;

/**
 * `match-detail-tabs` Requirement 12.5/12.6. Community_Dragon is a SEPARATE
 * Riot-operated CDN from Data_Dragon — Data_Dragon publishes no augment data
 * at all (verified 403 on every path tried). It is pinned the same way
 * Data_Dragon is: never `"latest"`, always a specific version — but Community
 * Dragon's own versioning accepts only a `{major}.{minor}` pair, not
 * `DDRAGON_VERSION`'s full three-part form, so `communityDragonVersionOf`
 * derives one from the other rather than introducing a second configuration
 * value that could drift from it.
 */
export const COMMUNITY_DRAGON_BASE = 'https://raw.communitydragon.org';

/**
 * `"16.17.1"` -> `"16.17"`. Falls back to the input unchanged if it does not
 * have at least two dot-separated segments — malformed input should not throw,
 * and an unusable version already makes every other accessor resolve to `null`.
 */
export function communityDragonVersionOf(ddragonVersion: string): string {
  const parts = ddragonVersion.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : ddragonVersion;
}

/** One champion, trimmed to what rendering needs. */
export interface ChampionEntry {
  /** Display name, e.g. `Wukong` for the key `MonkeyKing`. */
  name: string;
  /** Image filename from the metadata's `image.full`, e.g. `MonkeyKing.png`. */
  image: string;
}

/** One line of an item's `<stats>` block, e.g. `{ amount: '75', stat: 'Attack Damage' }`. */
export interface AssetStatLine {
  /** The numeric part with any unit, e.g. `75`, `25%`. `''` when the line had no leading number. */
  amount: string;
  /** The stat name, e.g. `Attack Damage`. Rendered with an icon by `StatIcon`. */
  stat: string;
}

/**
 * A parsed asset tooltip: the flat stat lines (items only) and the body
 * paragraphs (passive/active effects, spell text). Rendered as
 * name -> stats -> description by `Tooltip`.
 */
export interface AssetDescription {
  stats: AssetStatLine[];
  /** Effect text, split on blank lines. A single `\n` inside a paragraph is a soft break. */
  paragraphs: string[];
}

export const EMPTY_ASSET_DESCRIPTION: AssetDescription = { stats: [], paragraphs: [] };

/** One item, trimmed to what rendering needs. */
export interface ItemEntry {
  name: string;
  image: string;
  /** Precomputed at index time; see `classifyCompletedItem`. */
  completed: boolean;
  /** Parsed effect summary for the hover tooltip; empty stats + paragraphs when none. */
  description: AssetDescription;
}

/** One summoner spell, or one rune, or one rune tree. Same shape, same lookup. */
export interface NamedIconEntry {
  name: string;
  /** Data Dragon's `image.full` (spells) or `icon` (runes, trees) field, verbatim. */
  icon: string;
  /** Parsed effect summary for the hover tooltip; empty stats + paragraphs when none. */
  description: AssetDescription;
  /** Summoner spells only: `cooldownBurn` from `summoner.json`, e.g. `"300"`. Absent otherwise. */
  cooldown?: string;
}

const DESCRIPTION_MAX = 700;

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  ndash: '–',
  mdash: '—',
};

function codePoint(value: number): string | null {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) {
    return null;
  }
  try {
    return String.fromCodePoint(value);
  } catch {
    return null;
  }
}

function decodeEntities(text: string): string {
  return (
    text
      .replace(/&#(\d+);/g, (whole, code) => codePoint(Number(code)) ?? whole)
      .replace(/&#x([0-9a-f]+);/gi, (whole, code) => codePoint(Number.parseInt(code, 16)) ?? whole)
      .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole)
      // Data Dragon leaves unresolved calculation tokens like `@f3@` / `@Effect1Amount@`
      // in some rune descriptions — there is no value to substitute, so drop them.
      .replace(/@[^@\s]+@/g, '?')
  );
}

/** Wraps a bare string (stat shard blurbs) as an `AssetDescription`. */
export function textAssetDescription(text: string): AssetDescription {
  const trimmed = text.trim();
  return trimmed.length > 0 ? { stats: [], paragraphs: [trimmed] } : EMPTY_ASSET_DESCRIPTION;
}

/**
 * Parses Data Dragon's HTML description fragment into structured tooltip content.
 *
 * Items carry a leading `<stats>75 Attack Damage<br>25% Critical Strike Chance</stats>`
 * block followed by `<passive>`/`<active>` effect text; spells and runes are effect
 * text only. The `<stats>` block becomes `stats[]` (each line split into amount +
 * name so `StatIcon` can render a glyph); everything else is tag-stripped, with
 * `<br><br>` becoming paragraph breaks and a lone `<br>` a soft line break.
 *
 * `fallback` (an item's `plaintext`) is used both when there is no raw string and
 * when the raw string has stats but no effect text — Infinity Edge, for example,
 * is `<stats>...</stats><br><br>` with an empty body, and the one-line plaintext
 * ("Massively enhances critical strikes") is better than showing nothing.
 */
export function parseAssetDescription(raw: unknown, fallback = ''): AssetDescription {
  const fallbackText = typeof fallback === 'string' ? fallback.trim() : '';
  if (typeof raw !== 'string' || raw.length === 0) {
    return textAssetDescription(fallbackText);
  }

  let body = raw;
  let stats: AssetStatLine[] = [];
  const statsMatch = raw.match(/<stats>([\s\S]*?)<\/stats>/i);
  if (statsMatch) {
    stats = statsMatch[1]
      .split(/<br\s*\/?>/i)
      .map((segment) => decodeEntities(stripTags(segment)).replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const match = line.match(/^([+-]?[\d.,]+\s*%?)\s+(.*)$/);
        return match
          ? { amount: match[1].replace(/\s+/g, ''), stat: match[2].trim() }
          : { amount: '', stat: line };
      });
    body = raw.slice(0, statsMatch.index) + raw.slice((statsMatch.index ?? 0) + statsMatch[0].length);
  }

  const text = decodeEntities(stripTags(body.replace(/<br\s*\/?>/gi, '\n')))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const capped = text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX).trimEnd()}…` : text;
  const paragraphs = capped
    .split('\n\n')
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  if (paragraphs.length === 0 && fallbackText.length > 0) {
    return { stats, paragraphs: [fallbackText] };
  }
  return { stats, paragraphs };
}

/**
 * Requirement 7.7. Data_Dragon publishes no stat shard metadata anywhere —
 * `runesReforged.json` was searched and confirmed to carry no entry for any
 * `perks.statPerks` value (design.md decision, "Stat shards have no metadata
 * anywhere"). This table is this codebase's only source for the mapping.
 *
 * Task 1.2 verified seven of these nine ids against 228 real match participants.
 * `5002` and `5003` were never observed and may be identifiers the game no longer
 * assigns — see design.md's stat shard table for the per-id observation counts.
 * They stay in this table because non-observation does not establish absence, but
 * they carry no stronger guarantee than "the icon file exists".
 */
const STAT_SHARD_TABLE: Readonly<Record<number, NamedIconEntry>> = {
  5001: { name: 'Health Scaling', icon: 'perk-images/StatMods/StatModsHealthScalingIcon.png', description: textAssetDescription('+10-180 Health (based on level)') },
  5002: { name: 'Armor', icon: 'perk-images/StatMods/StatModsArmorIcon.png', description: textAssetDescription('+6 Armor') },
  5003: { name: 'Magic Resist', icon: 'perk-images/StatMods/StatModsMagicResIcon.png', description: textAssetDescription('+8 Magic Resist') },
  5005: { name: 'Attack Speed', icon: 'perk-images/StatMods/StatModsAttackSpeedIcon.png', description: textAssetDescription('+10% Attack Speed') },
  5007: { name: 'Ability Haste', icon: 'perk-images/StatMods/StatModsCDRScalingIcon.png', description: textAssetDescription('+8 Ability Haste') },
  5008: { name: 'Adaptive Force', icon: 'perk-images/StatMods/StatModsAdaptiveForceIcon.png', description: textAssetDescription('+5.4 Attack Damage or +9 Ability Power (adaptive)') },
  5010: { name: 'Movement Speed', icon: 'perk-images/StatMods/StatModsMovementSpeedIcon.png', description: textAssetDescription('+2% Movement Speed') },
  5011: { name: 'Health', icon: 'perk-images/StatMods/StatModsHealthPlusIcon.png', description: textAssetDescription('+65 Health') },
  5013: { name: 'Tenacity', icon: 'perk-images/StatMods/StatModsTenacityIcon.png', description: textAssetDescription('+10% Tenacity and Slow Resist') },
};

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
  /**
   * Keyed by the spell's numeric id as a string. `summoner.json` reports `key` as
   * a string keyed under the spell's *name*; this index inverts that to id-keyed
   * at build time, once, because Match-V5 reports `summoner1Id`/`summoner2Id` as
   * numbers and every lookup site wants that direction.
   */
  spells: Record<string, NamedIconEntry>;
  /** Keyed by rune id as a string, flattened across every tree and slot. */
  runes: Record<string, NamedIconEntry>;
  /** Keyed by rune tree id as a string (e.g. `8100` for Domination). */
  runeTrees: Record<string, NamedIconEntry>;
  /**
   * `match-detail-tabs` Requirement 12.1/12.5. Keyed by augment id as a string,
   * from Community_Dragon's `cherry-augments.json` — a different CDN from every
   * other map here. This mapping's `id` space is UNVERIFIED against real
   * `playerAugmentN` values (see README's Assets section); it is this
   * codebase's best available candidate, not a confirmed one.
   */
  augments: Record<string, NamedIconEntry>;
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
  /** Parsed effect summary for the hover tooltip; empty when unresolvable or absent. */
  itemDescription(id: number): AssetDescription;
  /** Serves `item-timeline`'s Requirement 3.2. False when unresolvable. */
  isCompletedItem(id: number): boolean;
  /** Requirement 8.2. The identifier as a string when unresolvable. */
  summonerSpellDisplayName(id: number): string;
  /** Parsed effect summary for the hover tooltip; leads with a Cooldown stat line when known. */
  summonerSpellDescription(id: number): AssetDescription;
  /** Requirement 7.2. Versioned path — spells are not part of the 7.4 exception. */
  summonerSpellIconUrl(id: number): string | null;
  /** Requirement 8.3. */
  runeDisplayName(id: number): string;
  /** Parsed effect summary for the hover tooltip; empty when unresolvable or absent. */
  runeDescription(id: number): AssetDescription;
  /** Requirement 7.3/7.4. Unversioned path — see `DDRAGON_UNVERSIONED_IMG_BASE`. */
  runeIconUrl(id: number): string | null;
  /** Requirement 8.3. */
  runeTreeDisplayName(styleId: number): string;
  /** Requirement 7.3/7.4. Unversioned path. */
  runeTreeIconUrl(styleId: number): string | null;
  /** Requirement 8.3. */
  statShardDisplayName(id: number): string;
  /** Parsed stat summary for the hover tooltip; empty when unresolvable. */
  statShardDescription(id: number): AssetDescription;
  /** Requirement 7.4/7.7. Unversioned path, identifier-to-file mapping hardcoded. */
  statShardIconUrl(id: number): string | null;
  /** Requirement 12.7. The identifier as a string when unresolvable. Name only — no description (Requirement 12.8). */
  augmentDisplayName(id: number): string;
  /** Requirement 12.5/12.6. Community_Dragon, pinned to a derived `{major}.{minor}` version — not Data_Dragon. */
  augmentIconUrl(id: number): string | null;
  /**
   * Ranked-tier emblem for a League-V4 `tier` string (`GOLD`, `EMERALD`, …).
   * `null` for anything that is not one of the ten real tiers, including
   * `UNRANKED`. Community_Dragon, needs only the version — not the index.
   */
  rankEmblemUrl(tier: string): string | null;
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

function isAssetDescription(candidate: unknown): candidate is AssetDescription {
  const value = candidate as AssetDescription | null;
  return (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray(value.stats) &&
    Array.isArray(value.paragraphs)
  );
}

function isNamedIconEntry(candidate: unknown): candidate is NamedIconEntry {
  const entry = candidate as NamedIconEntry | null;
  return (
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.name === 'string' &&
    typeof entry.icon === 'string' &&
    isAssetDescription(entry.description)
  );
}

function isItemEntry(candidate: unknown): candidate is ItemEntry {
  const entry = candidate as ItemEntry | null;
  return (
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.name === 'string' &&
    typeof entry.image === 'string' &&
    isAssetDescription(entry.description)
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
  summonerJson?: unknown,
  runesJson?: unknown,
  cherryAugmentsJson?: unknown,
): StaticDataIndex {
  const champions: Record<string, ChampionEntry> = {};
  const items: Record<string, ItemEntry> = {};
  const spells: Record<string, NamedIconEntry> = {};
  const runes: Record<string, NamedIconEntry> = {};
  const runeTrees: Record<string, NamedIconEntry> = {};
  const augments: Record<string, NamedIconEntry> = {};

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
        description?: unknown;
        plaintext?: unknown;
      };
      const name = typeof entry?.name === 'string' ? entry.name : id;
      const image = typeof entry?.image?.full === 'string' ? entry.image.full : `${id}.png`;
      const description = parseAssetDescription(
        entry?.description,
        typeof entry?.plaintext === 'string' ? entry.plaintext : '',
      );
      items[id] = { name, image, completed: classifyCompletedItem(entry ?? {}), description };
    }
  }

  // summoner.json is keyed by spell NAME with `key` as the numeric id AS A STRING
  // (design.md: "The index must therefore be inverted"). Iterating `Object.entries`
  // reads the name-keyed data; only `entry.key` is used as the output key.
  const summonerData = (summonerJson as { data?: Record<string, unknown> } | null)?.data;
  if (summonerData && typeof summonerData === 'object') {
    for (const value of Object.values(summonerData)) {
      const entry = value as {
        key?: unknown;
        name?: unknown;
        description?: unknown;
        cooldownBurn?: unknown;
        image?: { full?: unknown };
      };
      if (typeof entry?.key !== 'string' || entry.key.length === 0) {
        continue; // No numeric id to key this entry under — nothing to invert.
      }
      const name = typeof entry.name === 'string' ? entry.name : entry.key;
      const icon = typeof entry.image?.full === 'string' ? entry.image.full : `${entry.key}.png`;
      const cooldown =
        typeof entry.cooldownBurn === 'string' && entry.cooldownBurn.length > 0 ? entry.cooldownBurn : undefined;
      spells[entry.key] = { name, icon, description: parseAssetDescription(entry.description), cooldown };
    }
  }

  // runesReforged.json is an array of trees, each with slots of runes. Both a
  // rune-id index and a tree-id index are derived in the same pass.
  if (Array.isArray(runesJson)) {
    for (const tree of runesJson) {
      const treeEntry = tree as {
        id?: unknown;
        name?: unknown;
        icon?: unknown;
        slots?: { runes?: unknown[] }[];
      };
      if (typeof treeEntry?.id === 'number' && Number.isInteger(treeEntry.id)) {
        const treeName = typeof treeEntry.name === 'string' ? treeEntry.name : String(treeEntry.id);
        const treeIcon = typeof treeEntry.icon === 'string' ? treeEntry.icon : '';
        runeTrees[String(treeEntry.id)] = { name: treeName, icon: treeIcon, description: EMPTY_ASSET_DESCRIPTION };
      }
      if (!Array.isArray(treeEntry?.slots)) {
        continue;
      }
      for (const slot of treeEntry.slots) {
        const slotRunes = (slot as { runes?: unknown[] })?.runes;
        if (!Array.isArray(slotRunes)) {
          continue;
        }
        for (const rune of slotRunes) {
          const runeEntry = rune as { id?: unknown; name?: unknown; icon?: unknown; shortDesc?: unknown; longDesc?: unknown };
          if (typeof runeEntry?.id !== 'number' || !Number.isInteger(runeEntry.id)) {
            continue;
          }
          const name = typeof runeEntry.name === 'string' ? runeEntry.name : String(runeEntry.id);
          const icon = typeof runeEntry.icon === 'string' ? runeEntry.icon : '';
          const rawDesc =
            typeof runeEntry.longDesc === 'string' && runeEntry.longDesc.length > 0
              ? runeEntry.longDesc
              : runeEntry.shortDesc;
          runes[String(runeEntry.id)] = { name, icon, description: parseAssetDescription(rawDesc) };
        }
      }
    }
  }

  // cherry-augments.json (Community_Dragon) is a flat array, unlike every
  // Data_Dragon file above — `{ id, nameTRA, augmentSmallIconPath, ... }`.
  // The icon path is stored relative (lowercased, `/lol-game-data/assets/`
  // stripped) rather than as a full URL, so the accessor can build the URL
  // against whichever Community_Dragon version is current at call time — the
  // same "store the filename, resolve the base at read time" pattern every
  // other entry in this index already uses.
  if (Array.isArray(cherryAugmentsJson)) {
    const assetsPrefix = '/lol-game-data/assets/';
    for (const entry of cherryAugmentsJson) {
      const augment = entry as { id?: unknown; nameTRA?: unknown; augmentSmallIconPath?: unknown };
      if (typeof augment?.id !== 'number' || !Number.isInteger(augment.id)) {
        continue;
      }
      const name = typeof augment.nameTRA === 'string' && augment.nameTRA.length > 0 ? augment.nameTRA : String(augment.id);
      const rawPath = typeof augment.augmentSmallIconPath === 'string' ? augment.augmentSmallIconPath : '';
      const icon = rawPath.toLowerCase().startsWith(assetsPrefix.toLowerCase())
        ? rawPath.slice(assetsPrefix.length)
        : rawPath;
      augments[String(augment.id)] = { name, icon: icon.toLowerCase(), description: EMPTY_ASSET_DESCRIPTION };
    }
  }

  return { version, champions, items, spells, runes, runeTrees, augments };
}

/**
 * The ten ranked tiers, lowercased. League-V4 reports `tier` uppercase
 * (`GOLD`); Community_Dragon's emblem filenames are lowercase
 * (`emblem-gold.png`). Matching against this set both normalises the casing and
 * rejects anything that is not a real tier (`UNRANKED`, a future tier name)
 * before it can become a 404ing URL.
 */
const RANKED_TIERS: ReadonlySet<string> = new Set([
  'iron',
  'bronze',
  'silver',
  'gold',
  'platinum',
  'emerald',
  'diamond',
  'master',
  'grandmaster',
  'challenger',
]);

/** `id` after the shared usability check, as a lookup key. Never throws. */
function usableIdKey(id: number): string | null {
  return isUsableId(id) ? String(id) : null;
}

/** Requirement 7.4: rune, tree, and stat shard images live at the unversioned path. */
function unversionedIconUrl(iconPath: string): string | null {
  if (iconPath.length === 0) {
    return null;
  }
  return `${DDRAGON_UNVERSIONED_IMG_BASE}/${iconPath}`;
}

/** Requirement 12.5/12.6: pinned to a derived Community_Dragon version, never "latest". */
function communityDragonIconUrl(ddragonVersion: string, iconPath: string): string | null {
  if (iconPath.length === 0) {
    return null;
  }
  const version = communityDragonVersionOf(ddragonVersion);
  return `${COMMUNITY_DRAGON_BASE}/${version}/plugins/rcp-be-lol-game-data/global/default/${iconPath}`;
}

/**
 * Ranked-tier emblems live in the FRONT-END static-assets plugin
 * (`rcp-fe-lol-static-assets`), not the game-data plugin the augment/rune icons
 * come from. Same CDN, same version pin, different plugin root.
 */
function communityDragonStaticAssetUrl(ddragonVersion: string, iconPath: string): string | null {
  if (iconPath.length === 0) {
    return null;
  }
  const version = communityDragonVersionOf(ddragonVersion);
  return `${COMMUNITY_DRAGON_BASE}/${version}/plugins/rcp-fe-lol-static-assets/global/default/${iconPath}`;
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

    itemDescription(id: number): AssetDescription {
      if (!isUsableId(id) || id === 0) {
        return EMPTY_ASSET_DESCRIPTION;
      }
      return lookupEntry(usable?.items, String(id), isItemEntry)?.description ?? EMPTY_ASSET_DESCRIPTION;
    },

    isCompletedItem(id: number): boolean {
      if (usable === null || !isUsableId(id)) {
        return false;
      }
      return lookupEntry(usable.items, String(id), isItemEntry)?.completed === true;
    },

    summonerSpellDisplayName(id: number): string {
      const key = usableIdKey(id);
      if (key === null) {
        try {
          return String(id);
        } catch {
          return '';
        }
      }
      return lookupEntry(usable?.spells, key, isNamedIconEntry)?.name ?? key;
    },

    summonerSpellDescription(id: number): AssetDescription {
      const key = usableIdKey(id);
      if (key === null) {
        return EMPTY_ASSET_DESCRIPTION;
      }
      const entry = lookupEntry(usable?.spells, key, isNamedIconEntry);
      if (entry === undefined) {
        return EMPTY_ASSET_DESCRIPTION;
      }
      if (entry.cooldown === undefined || entry.cooldown.length === 0) {
        return entry.description;
      }
      // The cooldown is not in the description string — splice it in as the first
      // stat line so the tooltip reads name -> cooldown -> effect.
      return {
        stats: [{ amount: `${entry.cooldown}s`, stat: 'Cooldown' }, ...entry.description.stats],
        paragraphs: entry.description.paragraphs,
      };
    },

    summonerSpellIconUrl(id: number): string | null {
      // Requirement 7.2: spells are NOT part of the unversioned-path exception —
      // resolved against the pinned version, exactly like champion and item icons.
      const key = usableIdKey(id);
      if (base === null || usable === null || key === null) {
        return null;
      }
      const entry = lookupEntry(usable.spells, key, isNamedIconEntry);
      if (entry === undefined) {
        return null;
      }
      return `${base}/img/spell/${encodeURIComponent(entry.icon)}`;
    },

    runeDisplayName(id: number): string {
      const key = usableIdKey(id);
      if (key === null) {
        try {
          return String(id);
        } catch {
          return '';
        }
      }
      return lookupEntry(usable?.runes, key, isNamedIconEntry)?.name ?? key;
    },

    runeDescription(id: number): AssetDescription {
      const key = usableIdKey(id);
      if (key === null) {
        return EMPTY_ASSET_DESCRIPTION;
      }
      return lookupEntry(usable?.runes, key, isNamedIconEntry)?.description ?? EMPTY_ASSET_DESCRIPTION;
    },

    runeIconUrl(id: number): string | null {
      const key = usableIdKey(id);
      if (usable === null || key === null) {
        return null;
      }
      const entry = lookupEntry(usable.runes, key, isNamedIconEntry);
      if (entry === undefined) {
        return null;
      }
      return unversionedIconUrl(entry.icon);
    },

    runeTreeDisplayName(styleId: number): string {
      const key = usableIdKey(styleId);
      if (key === null) {
        try {
          return String(styleId);
        } catch {
          return '';
        }
      }
      return lookupEntry(usable?.runeTrees, key, isNamedIconEntry)?.name ?? key;
    },

    runeTreeIconUrl(styleId: number): string | null {
      const key = usableIdKey(styleId);
      if (usable === null || key === null) {
        return null;
      }
      const entry = lookupEntry(usable.runeTrees, key, isNamedIconEntry);
      if (entry === undefined) {
        return null;
      }
      return unversionedIconUrl(entry.icon);
    },

    statShardDisplayName(id: number): string {
      const key = usableIdKey(id);
      if (key === null) {
        try {
          return String(id);
        } catch {
          return '';
        }
      }
      // Not gated on `usable`: STAT_SHARD_TABLE is a hardcoded constant, not part
      // of the fetched/persisted index — Data_Dragon publishes no such metadata
      // (Requirement 7.7), so there is nothing here for the index to be "ready" for.
      const numeric = Number(key);
      return Object.prototype.hasOwnProperty.call(STAT_SHARD_TABLE, numeric)
        ? STAT_SHARD_TABLE[numeric].name
        : key;
    },

    statShardDescription(id: number): AssetDescription {
      const key = usableIdKey(id);
      if (key === null) {
        return EMPTY_ASSET_DESCRIPTION;
      }
      const numeric = Number(key);
      return Object.prototype.hasOwnProperty.call(STAT_SHARD_TABLE, numeric)
        ? STAT_SHARD_TABLE[numeric].description
        : EMPTY_ASSET_DESCRIPTION;
    },

    statShardIconUrl(id: number): string | null {
      const key = usableIdKey(id);
      if (key === null) {
        return null;
      }
      const numeric = Number(key);
      if (!Object.prototype.hasOwnProperty.call(STAT_SHARD_TABLE, numeric)) {
        return null;
      }
      return unversionedIconUrl(STAT_SHARD_TABLE[numeric].icon);
    },

    augmentDisplayName(id: number): string {
      const key = usableIdKey(id);
      if (key === null) {
        try {
          return String(id);
        } catch {
          return '';
        }
      }
      return lookupEntry(usable?.augments, key, isNamedIconEntry)?.name ?? key;
    },

    augmentIconUrl(id: number): string | null {
      // `version` (not `usable`'s version) — augments come from a hardcoded-URL
      // pattern over Community_Dragon, but the LOOKUP still needs the fetched
      // index, so this IS gated on `usable`, unlike stat shards.
      const key = usableIdKey(id);
      if (usable === null || version === null || key === null) {
        return null;
      }
      const entry = lookupEntry(usable.augments, key, isNamedIconEntry);
      if (entry === undefined) {
        return null;
      }
      return communityDragonIconUrl(version, entry.icon);
    },

    rankEmblemUrl(tier: string): string | null {
      // Not gated on `usable`: the emblem filename IS the tier name, so this
      // resolves as soon as the version is known — like `profileIconUrl`.
      if (version === null || typeof tier !== 'string') {
        return null;
      }
      const name = tier.trim().toLowerCase();
      if (!RANKED_TIERS.has(name)) {
        return null;
      }
      return communityDragonStaticAssetUrl(version, `images/ranked-emblem/emblem-${name}.png`);
    },
  };
}
