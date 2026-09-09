import { describe, it, expect } from 'vitest';
import type { Db } from 'mongodb';
import type { RunePage } from '../insight/stats';
import { CHAMPION_BUILD_TOTALS_COLLECTION } from '../champions/pipeline/constants';
import {
  serializeItemPath,
  serializeRunePage,
  serializeSkillOrder,
  serializeSpellPair,
  serializeStartingItems,
} from '../champions/pipeline/serialize';
import {
  MongoChampionStatsStore,
  createInMemoryChampionStatsStore,
  type ChampionAggregate,
} from './championStatsStore';

/**
 * A tiny fake `Db` covering exactly what `MongoChampionStatsStore` calls:
 * `collection(name).find(filter, opts).toArray()` and `.findOne(filter)`.
 */
function fakeDb(
  aggregateDocs: Record<string, unknown>[],
  totalsDocs: Record<string, unknown>[] = [],
): Db {
  function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
    return Object.entries(filter).every(([k, v]) => doc[k] === v);
  }
  function coll(docs: Record<string, unknown>[]) {
    return {
      find: (filter: Record<string, unknown> = {}) => ({
        toArray: () => Promise.resolve(docs.filter((d) => matches(d, filter))),
      }),
      findOne: (filter: Record<string, unknown> = {}) =>
        Promise.resolve(docs.find((d) => matches(d, filter)) ?? null),
    };
  }
  return {
    collection: (name: string) =>
      name === CHAMPION_BUILD_TOTALS_COLLECTION ? coll(totalsDocs) : coll(aggregateDocs),
  } as unknown as Db;
}

const RUNES: RunePage = {
  primaryStyle: 8100,
  secondaryStyle: 8000,
  primarySelections: [8112, 8126, 8138, 8135],
  secondarySelections: [9111, 8014],
  statShards: [5008, 5008, 5001],
};

/** A stored aggregate doc as the crawler's aggregator would write it. */
function storedCell(overrides: {
  championKey?: string;
  role?: string;
  rankBucket?: string;
  patch?: string;
  games: number;
  wins: number;
  paths: {
    coreItems: number[];
    games: number;
    wins: number;
    skills?: number;
    runes?: number;
    spells?: number;
    starts?: number;
  }[];
}) {
  const championKey = overrides.championKey ?? 'Jinx';
  const role = overrides.role ?? 'BOTTOM';
  const rankBucket = overrides.rankBucket ?? 'EMERALD_PLUS';
  const patch = overrides.patch ?? '16.17';
  const itemPaths: Record<string, unknown> = {};
  for (const p of overrides.paths) {
    itemPaths[serializeItemPath(p.coreItems)] = {
      games: p.games,
      wins: p.wins,
      skills: { [serializeSkillOrder({ maxOrder: ['Q'], perLevel: [1, 1, 1, 1, 1] })]: p.skills ?? p.games },
      runes: { [serializeRunePage(RUNES)]: p.runes ?? p.games },
      spells: { [serializeSpellPair([4, 7])]: p.spells ?? p.games },
      starts: { [serializeStartingItems([1055])]: p.starts ?? p.games },
    };
  }
  return {
    _id: `${championKey}|${role}|${rankBucket}|world|${patch}`,
    championKey,
    role,
    rankBucket,
    region: 'world',
    patch,
    games: overrides.games,
    wins: overrides.wins,
    lastUpdatedAt: new Date(1_700_000_000_000),
    itemPaths,
  };
}

/** The same data as a `ChampionAggregate` for the in-memory fake. */
function inMemoryCell(stored: ReturnType<typeof storedCell>): ChampionAggregate {
  return {
    championKey: stored.championKey,
    role: stored.role as ChampionAggregate['role'],
    rank: stored.rankBucket as ChampionAggregate['rank'],
    region: 'world',
    patch: stored.patch,
    lastUpdatedAt: stored.lastUpdatedAt.getTime(),
    games: stored.games,
    wins: stored.wins,
    pickRate: 0,
    itemPaths: Object.entries(stored.itemPaths as Record<string, { games: number; wins: number }>).map(
      ([key, p]) => ({
        coreItems: key.split('-').map(Number),
        games: p.games,
        wins: p.wins,
        skillOrders: [{ value: { maxOrder: ['Q'], perLevel: [1, 1, 1, 1, 1] }, games: p.games }],
        runePages: [{ value: RUNES, games: p.games }],
        spellPairs: [{ value: [4, 7], games: p.games }],
        startingItems: [{ value: [1055], games: p.games }],
      }),
    ),
  };
}

const FILTERS = { role: 'BOTTOM', rank: 'EMERALD_PLUS', region: 'world' } as const;

describe('MongoChampionStatsStore', () => {
  it('returns null for a champion with no aggregate docs', async () => {
    const store = new MongoChampionStatsStore(fakeDb([]));
    expect(await store.getBuildStats('Jinx', FILTERS)).toBeNull();
  });

  it('popular / highestWinRate match the in-memory fake for the same data', async () => {
    const stored = storedCell({
      games: 1200,
      wins: 640,
      paths: [
        { coreItems: [3031, 6672, 3036], games: 800, wins: 460 },
        { coreItems: [6672, 3094, 3036], games: 400, wins: 180 },
      ],
    });
    const mongo = await new MongoChampionStatsStore(fakeDb([stored])).getBuildStats('Jinx', FILTERS);
    const memory = await createInMemoryChampionStatsStore([inMemoryCell(stored)]).getBuildStats(
      'Jinx',
      FILTERS,
    );

    expect(mongo?.popular).toEqual(memory?.popular);
    expect(mongo?.highestWinRate).toEqual(memory?.highestWinRate);
    expect(mongo?.popular?.coreItems).toEqual([[3031], [6672], [3036]]);
    expect(mongo?.popular?.runes?.value).toEqual(RUNES);
  });

  it('computes overall.pickRate from the role-agnostic totals doc', async () => {
    const stored = storedCell({ games: 900, wins: 500, paths: [{ coreItems: [1, 2, 3], games: 900, wins: 500 }] });
    const store = new MongoChampionStatsStore(
      fakeDb([stored], [{ _id: 'EMERALD_PLUS|world|16.17', matches: 5000 }]),
    );
    const result = await store.getBuildStats('Jinx', FILTERS);
    expect(result?.meta.overall.pickRate).toBeCloseTo(900 / 5000);
    expect(result?.meta.overall.winRate).toBeCloseTo(500 / 900);
    expect(result?.meta.overall.totalGames).toBe(900);
  });

  it('populated meta + popular:null for a known champion but an unseen filter combo', async () => {
    const stored = storedCell({ role: 'BOTTOM', games: 900, wins: 450, paths: [{ coreItems: [1, 2, 3], games: 900, wins: 450 }] });
    const result = await new MongoChampionStatsStore(fakeDb([stored])).getBuildStats('Jinx', {
      role: 'TOP',
      rank: 'MASTER_PLUS',
      region: 'world',
    });
    expect(result).not.toBeNull();
    expect(result?.popular).toBeNull();
    expect(result?.meta.availableRoles).toContain('BOTTOM');
    expect(result?.meta.defaultRank).toBe('ALL');
  });

  it('picks the newest patch by numeric major.minor, not string order', async () => {
    const old = storedCell({ patch: '16.9', games: 999, wins: 999, paths: [{ coreItems: [9, 9, 9], games: 999, wins: 999 }] });
    const recent = storedCell({ patch: '16.17', games: 100, wins: 40, paths: [{ coreItems: [1, 2, 3], games: 100, wins: 40 }] });
    const result = await new MongoChampionStatsStore(fakeDb([old, recent])).getBuildStats('Jinx', FILTERS);
    expect(result?.meta.patch).toBe('16.17');
    expect(result?.popular?.coreItems).toEqual([[1], [2], [3]]);
  });

  it('returns null when a read throws', async () => {
    const db = {
      collection: () => ({
        find: () => ({ toArray: () => Promise.reject(new Error('mongo down')) }),
        findOne: () => Promise.reject(new Error('mongo down')),
      }),
    } as unknown as Db;
    expect(await new MongoChampionStatsStore(db).getBuildStats('Jinx', FILTERS)).toBeNull();
  });
});
