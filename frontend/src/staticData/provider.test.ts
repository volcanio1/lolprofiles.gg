import { describe, expect, it } from 'vitest';
import {
  buildStaticDataIndex,
  classifyCompletedItem,
  createStaticDataProvider,
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
    '3031': { name: 'Infinity Edge', image: { full: '3031.png' }, depth: 2, gold: { total: 3500 }, tags: ['Damage'] },
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

const VERSION = '16.17.1';
const index: StaticDataIndex = buildStaticDataIndex(VERSION, CHAMPION_JSON, ITEM_JSON);
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
