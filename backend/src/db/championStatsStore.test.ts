import { describe, it, expect } from 'vitest';
import type { RunePage } from '../insight/stats';
import {
  createInMemoryChampionStatsStore,
  createNoopChampionStatsStore,
  resolveBuilds,
  type ChampionAggregate,
  type ChampionSkillOrder,
  type ItemPathAggregate,
} from './championStatsStore';
import { MIN_SAMPLE } from '../champions/buildStatsConstants';

const RUNES_A: RunePage = {
  primaryStyle: 8100,
  secondaryStyle: 8000,
  primarySelections: [8112, 8126, 8138, 8135],
  secondarySelections: [9111, 8014],
  statShards: [5008, 5008, 5001],
};
const SKILLS_A: ChampionSkillOrder = { maxOrder: ['Q', 'W', 'E'], perLevel: [1, 3, 2, 1] };

function itemPath(overrides: Partial<ItemPathAggregate> & Pick<ItemPathAggregate, 'coreItems' | 'games' | 'wins'>): ItemPathAggregate {
  return {
    skillOrders: [{ value: SKILLS_A, games: overrides.games }],
    runePages: [{ value: RUNES_A, games: overrides.games }],
    spellPairs: [{ value: [4, 7], games: overrides.games }],
    startingItems: [{ value: [1055, 2003], games: overrides.games }],
    ...overrides,
  };
}

function cell(overrides: Partial<ChampionAggregate> = {}): ChampionAggregate {
  const itemPaths = overrides.itemPaths ?? [itemPath({ coreItems: [3006, 3031, 3036], games: 900, wins: 500 })];
  return {
    championKey: 'Jinx',
    role: 'BOTTOM',
    rank: 'EMERALD_PLUS',
    region: 'world',
    patch: '16.17',
    lastUpdatedAt: 1_700_000_000_000,
    games: itemPaths.reduce((sum, p) => sum + p.games, 0),
    wins: itemPaths.reduce((sum, p) => sum + p.wins, 0),
    pickRate: 0.24,
    itemPaths,
    ...overrides,
  };
}

const FILTERS = { role: 'BOTTOM', rank: 'EMERALD_PLUS', region: 'world' } as const;

describe('resolveBuilds', () => {
  it('resolves popular slot-by-slot from the most-built item at each position', () => {
    const { popular } = resolveBuilds(
      cell({
        itemPaths: [
          itemPath({ coreItems: [1, 2, 3], games: 300, wins: 150 }),
          itemPath({ coreItems: [4, 5, 6], games: 700, wins: 350 }),
        ],
      }),
    );
    expect(popular?.coreItems).toEqual([[4], [5], [6]]);
    expect(popular?.matchCount).toBe(700);
    expect(popular?.pickRate).toBeCloseTo(0.7);
  });

  it('surfaces a "/" alternative when a slot has a near-equally-built runner-up', () => {
    const { popular } = resolveBuilds(
      cell({
        itemPaths: [
          // slot 1: 3006 (520) vs 3047 (480) — 0.92 ratio, both shown
          itemPath({ coreItems: [3006, 3031, 3036], games: 520, wins: 260 }),
          itemPath({ coreItems: [3047, 3031, 3036], games: 480, wins: 240 }),
        ],
      }),
    );
    expect(popular?.coreItems[0]).toEqual([3006, 3047]);
    // slot 2/3 are anchored on the leader (3006) cohort only → single items
    expect(popular?.coreItems[1]).toEqual([3031]);
    expect(popular?.coreItems[2]).toEqual([3036]);
  });

  it('anchors each slot on the previous slots’ leaders, not global frequency', () => {
    const { popular } = resolveBuilds(
      cell({
        itemPaths: [
          itemPath({ coreItems: [10, 20, 30], games: 700, wins: 350 }),
          itemPath({ coreItems: [11, 21, 30], games: 300, wins: 150 }),
        ],
      }),
    );
    // 10 leads slot 1; slot 2 must be 20 (pairs with 10), never 21
    expect(popular?.coreItems).toEqual([[10], [20], [30]]);
    expect(popular?.matchCount).toBe(700);
  });

  it('returns highestWinRate null when no path reaches MIN_SAMPLE', () => {
    const { popular, highestWinRate } = resolveBuilds(
      cell({
        itemPaths: [
          itemPath({ coreItems: [1, 2, 3], games: MIN_SAMPLE - 1, wins: MIN_SAMPLE - 1 }),
          itemPath({ coreItems: [4, 5, 6], games: 400, wins: 10 }),
        ],
      }),
    );
    expect(popular).not.toBeNull();
    expect(highestWinRate).toBeNull();
  });

  it('picks the best win rate only among paths at or above MIN_SAMPLE', () => {
    const { highestWinRate } = resolveBuilds(
      cell({
        itemPaths: [
          itemPath({ coreItems: [9, 9, 9], games: 100, wins: 100 }), // 100% but tiny
          itemPath({ coreItems: [1, 2, 3], games: MIN_SAMPLE, wins: 400 }), // 80%
          itemPath({ coreItems: [4, 5, 6], games: 1000, wins: 550 }), // 55%
        ],
      }),
    );
    expect(highestWinRate?.coreItems).toEqual([[1], [2], [3]]);
    expect(highestWinRate?.winRate).toBeCloseTo(0.8);
  });

  it('returns both builds null below BACKEND_DISPLAY_FLOOR total games', () => {
    const { popular, highestWinRate } = resolveBuilds(
      cell({ itemPaths: [itemPath({ coreItems: [1, 2, 3], games: 40, wins: 20 })] }),
    );
    expect(popular).toBeNull();
    expect(highestWinRate).toBeNull();
  });

  it('returns null builds for a null cell', () => {
    expect(resolveBuilds(null)).toEqual({ popular: null, highestWinRate: null });
  });

  it('emits a sub-section when its modal value is a plurality with enough games, else null', () => {
    const path = itemPath({ coreItems: [1, 2, 3], games: 1000, wins: 500 });
    const { popular } = resolveBuilds(
      cell({
        itemPaths: [
          {
            ...path,
            // top skill order = 3/1000 → below MODAL_MIN_GAMES → null
            skillOrders: [
              { value: SKILLS_A, games: 3 },
              { value: { maxOrder: ['W', 'Q', 'E'], perLevel: [2, 1, 3] }, games: 2 },
            ],
            // top spell pair = 40/1000 = 4% → below MODAL_MIN_SHARE → null
            spellPairs: [
              { value: [4, 7], games: 40 },
              { value: [4, 14], games: 38 },
            ],
            // top rune page = 150/1000 = 15% and ≥ MODAL_MIN_GAMES → emitted with its count
            runePages: [
              { value: RUNES_A, games: 150 },
              { value: { ...RUNES_A, secondaryStyle: 8200 }, games: 90 },
            ],
          },
        ],
      }),
    );
    expect(popular?.skillOrder).toBeNull();
    expect(popular?.summonerSpells).toBeNull();
    expect(popular?.runes?.value).toEqual(RUNES_A);
    expect(popular?.runes?.games).toBe(150);
  });

  it('trims coreItems to CORE_ITEM_COUNT slots', () => {
    const { popular } = resolveBuilds(
      cell({ itemPaths: [itemPath({ coreItems: [1, 2, 3, 4, 5, 6, 7, 8], games: 800, wins: 400 })] }),
    );
    expect(popular?.coreItems).toEqual([[1], [2], [3], [4], [5], [6]]);
  });
});

describe('InMemoryChampionStatsStore', () => {
  it('resolves null for a champion it has never aggregated', async () => {
    const store = createInMemoryChampionStatsStore([cell()]);
    expect(await store.getBuildStats('Ashe', FILTERS)).toBeNull();
  });

  it('returns populated meta + builds for a matching filter cell', async () => {
    const store = createInMemoryChampionStatsStore([cell()]);
    const result = await store.getBuildStats('Jinx', FILTERS);
    expect(result).not.toBeNull();
    expect(result?.meta.overall.totalGames).toBe(900);
    expect(result?.meta.overall.winRate).toBeCloseTo(500 / 900);
    expect(result?.meta.overall.pickRate).toBeCloseTo(0.24);
    expect(result?.meta.patch).toBe('16.17');
    expect(result?.popular?.coreItems).toEqual([[3006], [3031], [3036]]);
  });

  it('advertises every role/rank/region it has seen for the champion, in reference order', async () => {
    const store = createInMemoryChampionStatsStore([
      cell({ role: 'BOTTOM', rank: 'EMERALD_PLUS' }),
      cell({ role: 'MIDDLE', rank: 'DIAMOND_PLUS', games: 200, wins: 100 }),
      cell({ role: 'ALL', rank: 'ALL' }),
    ]);
    const result = await store.getBuildStats('Jinx', FILTERS);
    expect(result?.meta.availableRoles).toEqual(['ALL', 'MIDDLE', 'BOTTOM']);
    expect(result?.meta.availableRanks).toEqual(['ALL', 'EMERALD_PLUS', 'DIAMOND_PLUS']);
    expect(result?.meta.availableRegions).toEqual(['world']);
  });

  it('defaults role to the champion’s most-played non-ALL role', async () => {
    const store = createInMemoryChampionStatsStore([
      cell({ role: 'MIDDLE', itemPaths: [itemPath({ coreItems: [1, 2, 3], games: 300, wins: 150 })] }),
      cell({ role: 'BOTTOM', itemPaths: [itemPath({ coreItems: [1, 2, 3], games: 900, wins: 450 })] }),
    ]);
    const result = await store.getBuildStats('Jinx', FILTERS);
    expect(result?.meta.defaultRole).toBe('BOTTOM');
  });

  it('returns meta with zeroed overall + null builds when the champion is known but the filter combo is not', async () => {
    const store = createInMemoryChampionStatsStore([cell({ role: 'BOTTOM' })]);
    const result = await store.getBuildStats('Jinx', { role: 'TOP', rank: 'MASTER_PLUS', region: 'world' });
    expect(result).not.toBeNull();
    expect(result?.meta.overall.totalGames).toBe(0);
    expect(result?.popular).toBeNull();
    expect(result?.highestWinRate).toBeNull();
    // filters still work — the lists are populated
    expect(result?.meta.availableRoles).toContain('BOTTOM');
  });
});

describe('createNoopChampionStatsStore', () => {
  it('always resolves null', async () => {
    const store = createNoopChampionStatsStore();
    expect(await store.getBuildStats('Jinx', FILTERS)).toBeNull();
  });
});
