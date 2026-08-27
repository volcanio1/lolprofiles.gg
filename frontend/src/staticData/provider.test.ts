import { describe, expect, it } from 'vitest';
import {
  buildStaticDataIndex,
  classifyCompletedItem,
  communityDragonVersionOf,
  createStaticDataProvider,
  parseAssetDescription,
  type StaticDataIndex,
} from './provider';

/** Task 2.1 — Requirements 1.3, 1.4, 2.4, 5.3, 5.4. */

const CHAMPION_JSON = {
  data: {
    MonkeyKing: { name: 'Wukong', image: { full: 'MonkeyKing.png' }, key: '62' },
    Chogath: { name: "Cho'Gath", image: { full: 'Chogath.png' }, key: '31' },
    Aatrox: { name: 'Aatrox', image: { full: 'Aatrox.png' }, key: '266' },
  },
};

const ITEM_JSON = {
  data: {
    // Completed: built from components.
    '3031': {
      name: 'Infinity Edge',
      image: { full: '3031.png' },
      depth: 2,
      gold: { total: 3500 },
      tags: ['Damage'],
      description:
        '<mainText><stats><attention>65</attention> Attack Damage<br><attention>25%</attention> Critical Strike Chance</stats><br><br>Critical strikes deal <passive>bonus damage</passive>.</mainText>',
      plaintext: 'Massively increases critical strike damage',
    },
    // Completed: standalone, no depth, nothing builds out of it.
    '1055': { name: "Doran's Blade", image: { full: '1055.png' }, gold: { total: 450 }, tags: ['Damage'] },
    // Completed: builds into tier-3 boots but is finished in its own right.
    '3006': { name: "Berserker's Greaves", image: { full: '3006.png' }, depth: 2, gold: { total: 1100 }, tags: ['Boots'], into: ['3009'] },
    // Component.
    '1036': { name: 'Long Sword', image: { full: '1036.png' }, gold: { total: 350 }, tags: ['Damage'], into: ['1053'] },
    // Consumable.
    '2003': { name: 'Health Potion', image: { full: '2003.png' }, gold: { total: 50 }, tags: ['Consumable'] },
    // Trinket, zero cost.
    '3340': { name: 'Warding Totem', image: { full: '3340.png' }, gold: { total: 0 }, tags: ['Trinket'] },
  },
};

const SUMMONER_JSON = {
  data: {
    SummonerFlash: {
      key: '4',
      name: 'Flash',
      image: { full: 'SummonerFlash.png' },
      description: 'Teleports your champion a short distance toward your cursor.',
      cooldownBurn: '300',
    },
    SummonerBarrier: { key: '21', name: 'Barrier', image: { full: 'SummonerBarrier.png' } },
  },
};

const RUNES_JSON = [
  {
    id: 8100,
    name: 'Domination',
    icon: 'perk-images/Styles/7200_Domination.png',
    slots: [
      {
        runes: [
          {
            id: 8112,
            name: 'Electrocute',
            icon: 'perk-images/Styles/Domination/Electrocute/Electrocute.png',
            shortDesc: 'Hitting a champion with 3 attacks or abilities deals bonus damage.',
            longDesc: 'Hitting a champion with <b>3</b> separate attacks or abilities within 3s deals bonus adaptive damage.',
          },
        ],
      },
      { runes: [{ id: 8143, name: 'Sudden Impact', icon: 'perk-images/Styles/Domination/SuddenImpact/SuddenImpact.png' }] },
    ],
  },
  {
    id: 8000,
    name: 'Precision',
    icon: 'perk-images/Styles/7201_Precision.png',
    slots: [{ runes: [{ id: 8005, name: 'Press the Attack', icon: 'perk-images/Styles/Precision/PressTheAttack/PressTheAttack.png' }] }],
  },
];

const CHERRY_AUGMENTS_JSON = [
  { id: 1205, nameTRA: 'ADAPt', augmentSmallIconPath: '/lol-game-data/assets/ASSETS/UX/Cherry/Augments/Icons/ADAPt_small.png' },
  { id: 1141, nameTRA: 'All For You', augmentSmallIconPath: '/lol-game-data/assets/ASSETS/UX/Cherry/Augments/Icons/AllForYou_small.png' },
];

const VERSION = '16.17.1';
const index: StaticDataIndex = buildStaticDataIndex(VERSION, CHAMPION_JSON, ITEM_JSON, SUMMONER_JSON, RUNES_JSON, CHERRY_AUGMENTS_JSON);
const ready = createStaticDataProvider(VERSION, index);
const versionOnly = createStaticDataProvider(VERSION, null);
const empty = createStaticDataProvider(null, null);

/** Every value a hostile or half-loaded caller could realistically pass. */
const HOSTILE_IDS = [
  0,
  -0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  99_999_999,
  Number.MAX_SAFE_INTEGER,
  1e21, // stringifies as "1e+21" — a well-formed URL that can never resolve
];
/**
 * Includes prototype-chain keys deliberately. A plain-object map resolves
 * `constructor`, `toString`, `__proto__` and friends through `Object.prototype`, so
 * a `!== undefined` membership guard admits them — which produced a URL ending in
 * the literal string "undefined". The first version of this sweep omitted them and
 * the defect survived it.
 */
const PROTOTYPE_KEYS = [
  'constructor',
  'toString',
  'valueOf',
  '__proto__',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
];
const HOSTILE_KEYS = [
  '',
  ' ',
  'Nonexistent',
  'MonkeyKing ',
  '../../etc/passwd',
  '%%%',
  ...PROTOTYPE_KEYS,
];

describe('classifyCompletedItem (task 1.1 verified rule)', () => {
  it('treats items built from components as completed', () => {
    expect(classifyCompletedItem({ depth: 2, gold: { total: 3500 }, tags: ['Damage'] })).toBe(true);
  });

  it('treats a standalone finished item with no depth as completed', () => {
    expect(classifyCompletedItem({ gold: { total: 450 }, tags: ['Damage'] })).toBe(true);
  });

  it('treats upgradeable boots as completed even though they build into something', () => {
    expect(
      classifyCompletedItem({ depth: 2, gold: { total: 1100 }, tags: ['Boots'], into: ['3009'] }),
    ).toBe(true);
  });

  it('treats a component as not completed', () => {
    expect(classifyCompletedItem({ gold: { total: 350 }, tags: ['Damage'], into: ['1053'] })).toBe(false);
  });

  it('excludes consumables, trinkets and zero-cost entries', () => {
    expect(classifyCompletedItem({ gold: { total: 50 }, tags: ['Consumable'] })).toBe(false);
    expect(classifyCompletedItem({ gold: { total: 0 }, tags: ['Trinket'] })).toBe(false);
    expect(classifyCompletedItem({ gold: { total: 0 }, tags: ['Damage'] })).toBe(false);
  });

  it('never throws on a malformed entry', () => {
    expect(() => classifyCompletedItem({})).not.toThrow();
    expect(classifyCompletedItem({})).toBe(false);
  });
});

describe('buildStaticDataIndex', () => {
  it('maps a Champion_Key to its display name', () => {
    expect(index.champions.MonkeyKing.name).toBe('Wukong');
    expect(index.champions.Chogath.name).toBe("Cho'Gath");
  });

  it('takes the filename from image.full rather than constructing it from the key', () => {
    expect(index.champions.MonkeyKing.image).toBe('MonkeyKing.png');
  });

  it('precomputes item classification', () => {
    expect(index.items['3031'].completed).toBe(true);
    expect(index.items['1036'].completed).toBe(false);
  });

  it('never throws on malformed or absent metadata', () => {
    expect(() => buildStaticDataIndex(VERSION, null, null)).not.toThrow();
    expect(() => buildStaticDataIndex(VERSION, {}, { data: 'nonsense' })).not.toThrow();
    const degenerate = buildStaticDataIndex(VERSION, null, null);
    expect(degenerate.champions).toEqual({});
    expect(degenerate.items).toEqual({});
  });
});

describe('StaticDataProvider — readiness', () => {
  it('is ready only with a matching index', () => {
    expect(ready.ready).toBe(true);
    expect(versionOnly.ready).toBe(false);
    expect(empty.ready).toBe(false);
  });

  it('discards an index built for a different version', () => {
    const mismatched = createStaticDataProvider('15.24.1', index);
    expect(mismatched.ready).toBe(false);
    expect(mismatched.championIconUrl('MonkeyKing')).toBeNull();
  });
});

describe('StaticDataProvider — champions', () => {
  it('resolves the display name and the icon URL', () => {
    expect(ready.championDisplayName('MonkeyKing')).toBe('Wukong');
    expect(ready.championIconUrl('MonkeyKing')).toBe(
      'https://ddragon.leagueoflegends.com/cdn/16.17.1/img/champion/MonkeyKing.png',
    );
  });

  it('falls back to the raw key for an unknown champion, never to an empty name', () => {
    expect(ready.championDisplayName('Nonexistent')).toBe('Nonexistent');
    expect(ready.championIconUrl('Nonexistent')).toBeNull();
  });

  it('returns the key unchanged before the index has loaded', () => {
    expect(versionOnly.championDisplayName('MonkeyKing')).toBe('MonkeyKing');
    expect(versionOnly.championIconUrl('MonkeyKing')).toBeNull();
  });
});

describe('StaticDataProvider — profile icons', () => {
  it('treats 0 as a real icon, because Data Dragon serves one', () => {
    expect(ready.profileIconUrl(0)).toBe(
      'https://ddragon.leagueoflegends.com/cdn/16.17.1/img/profileicon/0.png',
    );
  });

  it('treats null as absent', () => {
    expect(ready.profileIconUrl(null)).toBeNull();
  });

  it('resolves before the index loads, since the filename is the identifier', () => {
    expect(versionOnly.profileIconUrl(29)).toBe(
      'https://ddragon.leagueoflegends.com/cdn/16.17.1/img/profileicon/29.png',
    );
  });

  it('returns null without a version', () => {
    expect(empty.profileIconUrl(29)).toBeNull();
  });
});

describe('StaticDataProvider — items', () => {
  it('resolves a known item', () => {
    expect(ready.itemIconUrl(3031)).toBe(
      'https://ddragon.leagueoflegends.com/cdn/16.17.1/img/item/3031.png',
    );
    expect(ready.itemDisplayName(3031)).toBe('Infinity Edge');
  });

  it('treats 0 as an EMPTY SLOT and never builds a URL for it', () => {
    expect(ready.itemIconUrl(0)).toBeNull();
  });

  it('returns null for an item absent from the pinned release', () => {
    expect(ready.itemIconUrl(99_999)).toBeNull();
    expect(ready.itemDisplayName(99_999)).toBe('99999');
  });

  it('exposes the precomputed classification, and false when unresolvable', () => {
    expect(ready.isCompletedItem(3031)).toBe(true);
    expect(ready.isCompletedItem(1036)).toBe(false);
    expect(ready.isCompletedItem(99_999)).toBe(false);
    expect(versionOnly.isCompletedItem(3031)).toBe(false);
  });
});

describe('parseAssetDescription', () => {
  it('splits the <stats> block into amount + name lines and strips the rest to paragraphs', () => {
    const parsed = parseAssetDescription(
      '<mainText><stats><attention>75</attention> Attack Damage<br><attention>25%</attention> Critical Strike Chance</stats><br><br><passive>Perfection</passive><br>Bonus damage.<br><br>Second effect.</mainText>',
    );
    expect(parsed.stats).toEqual([
      { amount: '75', stat: 'Attack Damage' },
      { amount: '25%', stat: 'Critical Strike Chance' },
    ]);
    expect(parsed.paragraphs).toEqual(['Perfection\nBonus damage.', 'Second effect.']);
  });

  it('handles effect-only text (spells, runes) with no stats block', () => {
    expect(parseAssetDescription('Teleports you a <b>short</b> distance.')).toEqual({
      stats: [],
      paragraphs: ['Teleports you a short distance.'],
    });
  });

  it('decodes numeric and named HTML entities', () => {
    expect(parseAssetDescription("Yuumi&#39;s bond &amp; the champion&rsquo;s aura.").paragraphs).toEqual([
      'Yuumi\'s bond & the champion’s aura.',
    ]);
  });

  it('uses the fallback string when the raw description is missing', () => {
    expect(parseAssetDescription(undefined, 'Enhances Move Speed')).toEqual({
      stats: [],
      paragraphs: ['Enhances Move Speed'],
    });
    expect(parseAssetDescription(undefined)).toEqual({ stats: [], paragraphs: [] });
  });

  it('uses the fallback when the raw string has stats but an empty body (Infinity Edge)', () => {
    const parsed = parseAssetDescription(
      '<mainText><stats><attention>75</attention> Attack Damage<br><attention>25%</attention> Critical Strike Chance</stats><br><br></mainText>',
      'Massively enhances critical strikes',
    );
    expect(parsed.stats).toEqual([
      { amount: '75', stat: 'Attack Damage' },
      { amount: '25%', stat: 'Critical Strike Chance' },
    ]);
    expect(parsed.paragraphs).toEqual(['Massively enhances critical strikes']);
  });

  it('caps very long body text with an ellipsis', () => {
    const parsed = parseAssetDescription('x'.repeat(900));
    expect(parsed.paragraphs[0].endsWith('…')).toBe(true);
    expect(parsed.paragraphs[0].length).toBeLessThan(720);
  });
});

describe('StaticDataProvider — hover descriptions', () => {
  it('exposes structured item stats and effect paragraphs', () => {
    expect(ready.itemDescription(3031)).toEqual({
      stats: [
        { amount: '65', stat: 'Attack Damage' },
        { amount: '25%', stat: 'Critical Strike Chance' },
      ],
      paragraphs: ['Critical strikes deal bonus damage.'],
    });
  });

  it('falls back to plaintext when an item has no rich description', () => {
    const built = buildStaticDataIndex(
      VERSION,
      CHAMPION_JSON,
      { data: { '1001': { name: 'Boots', image: { full: '1001.png' }, gold: { total: 300 }, plaintext: 'Enhances Movement Speed' } } },
      SUMMONER_JSON,
      RUNES_JSON,
    );
    expect(createStaticDataProvider(VERSION, built).itemDescription(1001)).toEqual({
      stats: [],
      paragraphs: ['Enhances Movement Speed'],
    });
  });

  it('leads a summoner spell description with its cooldown, then the effect text', () => {
    expect(ready.summonerSpellDescription(4)).toEqual({
      stats: [{ amount: '300s', stat: 'Cooldown' }],
      paragraphs: ['Teleports your champion a short distance toward your cursor.'],
    });
  });

  it('exposes a rune description, preferring longDesc', () => {
    expect(ready.runeDescription(8112).paragraphs[0]).toBe(
      'Hitting a champion with 3 separate attacks or abilities within 3s deals bonus adaptive damage.',
    );
  });

  it('exposes a stat shard description from the hardcoded table', () => {
    expect(ready.statShardDescription(5005)).toEqual({ stats: [], paragraphs: ['+10% Attack Speed'] });
  });

  it('returns an empty description when the identifier is unresolvable', () => {
    const empty = { stats: [], paragraphs: [] };
    expect(ready.itemDescription(99_999)).toEqual(empty);
    expect(ready.summonerSpellDescription(99_999)).toEqual(empty);
    expect(ready.runeDescription(99_999)).toEqual(empty);
    expect(versionOnly.itemDescription(3031)).toEqual(empty);
  });
});

describe('StaticDataProvider — totality (Requirements 5.3, 5.4)', () => {
  const providers = [
    ['ready', ready],
    ['version only', versionOnly],
    ['empty', empty],
  ] as const;

  for (const [label, provider] of providers) {
    it(`never throws and never yields a malformed URL — ${label}`, () => {
      for (const id of HOSTILE_IDS) {
        for (const url of [provider.profileIconUrl(id), provider.itemIconUrl(id)]) {
          expect(url === null || typeof url === 'string').toBe(true);
          if (url !== null) {
            expect(url).not.toMatch(/undefined|null|NaN|Infinity/);
            expect(url.startsWith('https://ddragon.leagueoflegends.com/')).toBe(true);
          }
        }
        expect(typeof provider.itemDisplayName(id)).toBe('string');
        expect(typeof provider.isCompletedItem(id)).toBe('boolean');
      }

      for (const key of HOSTILE_KEYS) {
        const url = provider.championIconUrl(key);
        expect(url === null || typeof url === 'string').toBe(true);
        if (url !== null) {
          expect(url).not.toMatch(/undefined|null/);
        }
        expect(typeof provider.championDisplayName(key)).toBe('string');
      }

      expect(provider.profileIconUrl(null)).toBeNull();
    });
  }

  it('never returns an empty string where a name was expected, unless the input was empty', () => {
    for (const key of HOSTILE_KEYS) {
      const name = ready.championDisplayName(key);
      expect(name === key).toBe(true);
      if (key.length > 0) {
        expect(name.length).toBeGreaterThan(0);
      }
    }
  });

  it('encodes identifiers rather than interpolating them raw into a URL', () => {
    const traversal = createStaticDataProvider(VERSION, {
      version: VERSION,
      champions: { Evil: { name: 'Evil', image: '../../evil.png' } },
      items: {},
      spells: {},
      runes: {},
      runeTrees: {},
      augments: {},
    });
    expect(traversal.championIconUrl('Evil')).not.toContain('../');
  });
});

describe('StaticDataProvider — regressions found in review', () => {
  it('never resolves a prototype-chain key as if it were a champion', () => {
    for (const key of PROTOTYPE_KEYS) {
      expect(ready.championIconUrl(key)).toBeNull();
      // Not "Object", which is what `champions['constructor'].name` yields.
      expect(ready.championDisplayName(key)).toBe(key);
    }
  });

  it('never resolves a prototype-chain key as if it were an item', () => {
    for (const key of PROTOTYPE_KEYS) {
      const asNumber = Number(key);
      expect(ready.itemIconUrl(asNumber)).toBeNull();
      expect(ready.isCompletedItem(asNumber)).toBe(false);
    }
  });

  it('survives an index whose entries are the wrong shape', () => {
    const malformed = createStaticDataProvider(VERSION, {
      version: VERSION,
      champions: { Broken: { name: 42, image: null } as never },
      items: { '1': { name: null } as never },
      spells: {},
      runes: {},
      runeTrees: {},
      augments: {},
    });
    expect(() => malformed.championIconUrl('Broken')).not.toThrow();
    expect(malformed.championIconUrl('Broken')).toBeNull();
    expect(malformed.championDisplayName('Broken')).toBe('Broken');
    expect(malformed.itemIconUrl(1)).toBeNull();
    expect(malformed.itemDisplayName(1)).toBe('1');
    expect(malformed.isCompletedItem(1)).toBe(false);
  });

  it('survives an index missing its maps entirely, rather than throwing in render', () => {
    const shapeless = createStaticDataProvider(VERSION, { version: VERSION } as never);
    expect(() => shapeless.championDisplayName('Aatrox')).not.toThrow();
    expect(shapeless.championDisplayName('Aatrox')).toBe('Aatrox');
    expect(shapeless.championIconUrl('Aatrox')).toBeNull();
    expect(shapeless.itemIconUrl(3031)).toBeNull();
    expect(shapeless.itemDisplayName(3031)).toBe('3031');
    expect(shapeless.isCompletedItem(3031)).toBe(false);
  });

  it('keeps the text alternative non-empty for a non-string key', () => {
    for (const key of [null, undefined, 62, {}] as unknown as string[]) {
      expect(ready.championDisplayName(key).length).toBeGreaterThan(0);
    }
  });

  it('rejects identifiers large enough to stringify exponentially', () => {
    expect(ready.profileIconUrl(1e21)).toBeNull();
    expect(ready.itemIconUrl(1e21)).toBeNull();
    expect(ready.profileIconUrl(Number.MAX_SAFE_INTEGER)).toContain(
      String(Number.MAX_SAFE_INTEGER),
    );
  });

  it('treats -0 as 0 on both sides of the empty-slot asymmetry', () => {
    expect(ready.profileIconUrl(-0)).toContain('/profileicon/0.png');
    expect(ready.itemIconUrl(-0)).toBeNull();
  });

  it('builds an index without throwing when an item has a non-iterable tags field', () => {
    for (const tags of [5, true, {}, 'Damage']) {
      expect(() =>
        buildStaticDataIndex(VERSION, null, {
          data: { '9999': { name: 'Odd', image: { full: '9999.png' }, tags, gold: { total: 100 } } },
        }),
      ).not.toThrow();
    }
    const built = buildStaticDataIndex(VERSION, CHAMPION_JSON, {
      data: {
        '9999': { name: 'Odd', image: { full: '9999.png' }, tags: 5, gold: { total: 100 } },
        '3031': ITEM_JSON.data['3031'],
      },
    });
    // One malformed entry must not cost the whole index.
    expect(Object.keys(built.champions)).toHaveLength(3);
    expect(built.items['3031'].completed).toBe(true);
  });

  it('counts an item with an empty into array as completed', () => {
    expect(classifyCompletedItem({ gold: { total: 450 }, tags: ['Damage'], into: [] })).toBe(true);
  });
});

/**
 * Task 1.4/1.5, Property 4: the four new asset URL families are total.
 *
 * Unlike Property 2 (`championIconUrl`, `itemIconUrl`), which asserts the URL
 * contains the pinned version, three of these four families are false by
 * construction (Requirement 7.4 — rune, tree and stat shard images are
 * unversioned). Only the totality half carries over: for every input including
 * `0`, negatives, non-integers, ids absent from the metadata, and
 * prototype-chain keys, each accessor returns a URL or `null` — never a throw,
 * never a URL containing the literal `undefined`.
 *
 * This codebase has no `fast-check` dependency in the frontend workspace (only
 * the backend does); the exhaustive `HOSTILE_IDS`/`PROTOTYPE_KEYS` sweep above is
 * this workspace's existing equivalent, so the property is exercised the same
 * way `championIconUrl`'s prototype-chain regression test already is.
 */
describe('StaticDataProvider — summoner spell, rune, rune tree, stat shard resolution', () => {
  it('resolves a summoner spell from its numeric id against the pinned (versioned) path', () => {
    expect(ready.summonerSpellIconUrl(4)).toBe(
      `https://ddragon.leagueoflegends.com/cdn/${VERSION}/img/spell/SummonerFlash.png`,
    );
    expect(ready.summonerSpellDisplayName(4)).toBe('Flash');
  });

  it('resolves a rune and its tree from unversioned paths', () => {
    expect(ready.runeIconUrl(8112)).toBe(
      'https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/Domination/Electrocute/Electrocute.png',
    );
    expect(ready.runeDisplayName(8112)).toBe('Electrocute');
    expect(ready.runeTreeIconUrl(8100)).toBe(
      'https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/7200_Domination.png',
    );
    expect(ready.runeTreeDisplayName(8100)).toBe('Domination');
  });

  it('flattens runes across every tree and every slot, not only the first of each', () => {
    expect(ready.runeDisplayName(8143)).toBe('Sudden Impact'); // Domination, second slot
    expect(ready.runeDisplayName(8005)).toBe('Press the Attack'); // Precision, first slot
    expect(ready.runeTreeDisplayName(8000)).toBe('Precision');
  });

  it('resolves a stat shard from the hardcoded table, unversioned, regardless of index readiness', () => {
    expect(ready.statShardIconUrl(5001)).toBe(
      'https://ddragon.leagueoflegends.com/cdn/img/perk-images/StatMods/StatModsHealthScalingIcon.png',
    );
    expect(ready.statShardDisplayName(5001)).toBe('Health Scaling');
    // Not gated on the fetched index — Data_Dragon publishes no stat shard metadata at all.
    expect(empty.statShardIconUrl(5001)).toBe(
      'https://ddragon.leagueoflegends.com/cdn/img/perk-images/StatMods/StatModsHealthScalingIcon.png',
    );
    expect(empty.statShardDisplayName(5001)).toBe('Health Scaling');
  });

  it('treats id 0 as unresolvable for a stat shard, unlike an item slot', () => {
    // 0 is a real, verified profile icon and an empty item slot elsewhere in this
    // module; it is neither for a stat shard — no id observed in real match data
    // (task 1.2) is 0, and the table simply has no entry for it.
    expect(ready.statShardIconUrl(0)).toBeNull();
    expect(ready.statShardDisplayName(0)).toBe('0');
  });

  it('falls back to the numeric identifier as the display name when unresolvable', () => {
    expect(ready.summonerSpellDisplayName(99_999)).toBe('99999');
    expect(ready.runeDisplayName(99_999)).toBe('99999');
    expect(ready.runeTreeDisplayName(99_999)).toBe('99999');
    expect(ready.statShardDisplayName(99_999)).toBe('99999');
  });

  it('is total for every hostile numeric id, on all eight accessors, before and after the index loads', () => {
    const providers = [ready, versionOnly, empty];
    for (const provider of providers) {
      for (const id of HOSTILE_IDS) {
        expect(() => provider.summonerSpellIconUrl(id)).not.toThrow();
        expect(() => provider.summonerSpellDisplayName(id)).not.toThrow();
        expect(() => provider.runeIconUrl(id)).not.toThrow();
        expect(() => provider.runeDisplayName(id)).not.toThrow();
        expect(() => provider.runeTreeIconUrl(id)).not.toThrow();
        expect(() => provider.runeTreeDisplayName(id)).not.toThrow();
        expect(() => provider.statShardIconUrl(id)).not.toThrow();
        expect(() => provider.statShardDisplayName(id)).not.toThrow();

        expect(provider.summonerSpellDisplayName(id).length).toBeGreaterThan(0);
        expect(provider.runeDisplayName(id).length).toBeGreaterThan(0);
        expect(provider.runeTreeDisplayName(id).length).toBeGreaterThan(0);
        expect(provider.statShardDisplayName(id).length).toBeGreaterThan(0);

        for (const url of [
          provider.summonerSpellIconUrl(id),
          provider.runeIconUrl(id),
          provider.runeTreeIconUrl(id),
          provider.statShardIconUrl(id),
        ]) {
          if (url !== null) {
            expect(url).not.toContain('undefined');
            expect(url).not.toContain('null');
          }
        }
      }
    }
  });

  it('never resolves a prototype-chain key as if it were a spell, rune, tree, or stat shard', () => {
    for (const key of PROTOTYPE_KEYS) {
      const asNumber = Number(key); // NaN for every one of these — exercises the isUsableId(NaN) path
      expect(ready.summonerSpellIconUrl(asNumber)).toBeNull();
      expect(ready.runeIconUrl(asNumber)).toBeNull();
      expect(ready.runeTreeIconUrl(asNumber)).toBeNull();
      expect(ready.statShardIconUrl(asNumber)).toBeNull();
    }
  });

  it('survives an index whose spell/rune maps are missing or malformed entirely', () => {
    const shapeless = createStaticDataProvider(VERSION, {
      version: VERSION,
      champions: {},
      items: {},
    } as never);
    expect(() => shapeless.summonerSpellIconUrl(4)).not.toThrow();
    expect(shapeless.summonerSpellIconUrl(4)).toBeNull();
    expect(shapeless.summonerSpellDisplayName(4)).toBe('4');
    expect(shapeless.runeIconUrl(8112)).toBeNull();
    expect(shapeless.runeTreeIconUrl(8100)).toBeNull();
    // Stat shards are unaffected — they never read the index.
    expect(shapeless.statShardIconUrl(5001)).not.toBeNull();
  });
});

/**
 * `match-detail-tabs` task 9.4 — Requirements 12.1, 12.5, 12.6, 12.7.
 *
 * Augments are the one asset class resolved from Community_Dragon rather than
 * Data_Dragon, at a version DERIVED from `DDRAGON_VERSION` (not a second
 * configuration value) — see `communityDragonVersionOf`.
 */
describe('StaticDataProvider — augment resolution (Community_Dragon)', () => {
  it('resolves an augment name and icon URL, pinned to the derived Community_Dragon version', () => {
    expect(ready.augmentDisplayName(1205)).toBe('ADAPt');
    expect(ready.augmentIconUrl(1205)).toBe(
      'https://raw.communitydragon.org/16.17/plugins/rcp-be-lol-game-data/global/default/assets/ux/cherry/augments/icons/adapt_small.png',
    );
  });

  it('derives the Community_Dragon version from DDRAGON_VERSION, never "latest"', () => {
    expect(communityDragonVersionOf('16.17.1')).toBe('16.17');
    expect(communityDragonVersionOf('16.17')).toBe('16.17');
    // Malformed input never throws and never falls back to "latest".
    expect(() => communityDragonVersionOf('')).not.toThrow();
    expect(communityDragonVersionOf('')).not.toContain('latest');
  });

  it('falls back to the numeric identifier as the display name when unresolvable', () => {
    expect(ready.augmentDisplayName(99_999)).toBe('99999');
    expect(ready.augmentIconUrl(99_999)).toBeNull();
  });

  it('is total for every hostile numeric id, before and after the index loads', () => {
    for (const provider of [ready, versionOnly, empty]) {
      for (const id of HOSTILE_IDS) {
        expect(() => provider.augmentIconUrl(id)).not.toThrow();
        expect(() => provider.augmentDisplayName(id)).not.toThrow();
        expect(provider.augmentDisplayName(id).length).toBeGreaterThan(0);
        const url = provider.augmentIconUrl(id);
        if (url !== null) {
          expect(url).not.toContain('undefined');
          expect(url).not.toContain('null');
        }
      }
    }
  });

  it('never resolves a prototype-chain key as if it were an augment', () => {
    for (const key of PROTOTYPE_KEYS) {
      const asNumber = Number(key);
      expect(ready.augmentIconUrl(asNumber)).toBeNull();
    }
  });

  it('survives an index whose augments map is missing entirely', () => {
    const shapeless = createStaticDataProvider(VERSION, {
      version: VERSION,
      champions: {},
      items: {},
    } as never);
    expect(() => shapeless.augmentIconUrl(1205)).not.toThrow();
    expect(shapeless.augmentIconUrl(1205)).toBeNull();
    expect(shapeless.augmentDisplayName(1205)).toBe('1205');
  });
});
