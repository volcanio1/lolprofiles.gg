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
  it('picks the most-played path as popular', () => {
    const { popular } = resolveBuilds(
      cell({
        itemPaths: [
          itemPath({ coreItems: [1, 2, 3], games: 300, wins: 150 }),
          itemPath({ coreItems: [4, 5, 6], games: 700, wins: 350 }),
        ],
      }),
    );
    expect(popular?.coreItems).toEqual([4, 5, 6]);
    expect(popular?.matchCount).toBe(700);
    expect(popular?.pickRate).toBeCloseTo(0.7);
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
    expect(highestWinRate?.coreItems).toEqual([1, 2, 3]);
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

  it('emits a sub-section only when its modal value clears MODAL_MIN_SHARE', () => {
    const path = itemPath({ coreItems: [1, 2, 3], games: 1000, wins: 500 });
    const { popular } = resolveBuilds(
      cell({
        itemPaths: [
          {
            ...path,
            // top skill order holds 200/1000 = 20% < 30% → null
            skillOrders: [
              { value: SKILLS_A, games: 200 },
              { value: { maxOrder: ['W', 'Q', 'E'], perLevel: [2, 1, 3] }, games: 150 },
            ],
            // top rune page holds 500/1000 = 50% ≥ 30% → emitted
            runePages: [{ value: RUNES_A, games: 500 }],
          },
        ],
      }),
    );
    expect(popular?.skillOrder).toBeNull();
    expect(popular?.runes).toEqual(RUNES_A);
  });

  it('trims coreItems to CORE_ITEM_COUNT', () => {
    const { popular } = resolveBuilds(
      cell({ itemPaths: [itemPath({ coreItems: [1, 2, 3, 4, 5], games: 800, wins: 400 })] }),
    );
    expect(popular?.coreItems).toEqual([1, 2, 3]);
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
    expect(result?.popular?.coreItems).toEqual([3006, 3031, 3036]);
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
