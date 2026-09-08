import { describe, it, expect, vi } from 'vitest';
import type { Db } from 'mongodb';
import { MAX_FREQ_KEYS } from './constants';
import type { Observation } from './extractor';
import { createAggregator, planAggregation, type AggregateDoc } from './aggregator';

const AT = new Date(1_700_000_000_000);

function obs(overrides: Partial<Observation> = {}): Observation {
  return {
    championKey: 'Jinx',
    role: 'BOTTOM',
    win: true,
    patch: '16.17',
    itemPath: [3031, 6672, 3172],
    startingItems: [1055],
    skillOrder: { maxOrder: ['Q'], perLevel: [1, 1, 1, 1, 1] },
    runePage: {
      primaryStyle: 8000,
      secondaryStyle: 8100,
      primarySelections: [8005, 9111],
      secondarySelections: [8135],
      statShards: [5008, 5008, 5001],
    },
    spellPair: [4, 7],
    ...overrides,
  };
}

describe('planAggregation', () => {
  it('fans a Diamond-tier observation into {role,ALL} × {EMERALD_PLUS,DIAMOND_PLUS,ALL}', () => {
    const { aggregateOps, totalsOps } = planAggregation([obs()], 'DIAMOND', new Map(), AT);

    expect(aggregateOps.map((o) => o.updateOne.filter._id).sort()).toEqual(
      [
        'Jinx|ALL|ALL|world|16.17',
        'Jinx|ALL|DIAMOND_PLUS|world|16.17',
        'Jinx|ALL|EMERALD_PLUS|world|16.17',
        'Jinx|BOTTOM|ALL|world|16.17',
        'Jinx|BOTTOM|DIAMOND_PLUS|world|16.17',
        'Jinx|BOTTOM|EMERALD_PLUS|world|16.17',
      ].sort(),
    );
    expect(totalsOps.map((o) => o.updateOne.filter._id).sort()).toEqual([
      'ALL|world|16.17',
      'DIAMOND_PLUS|world|16.17',
      'EMERALD_PLUS|world|16.17',
    ]);
  });

  it('an Emerald-tier observation only reaches EMERALD_PLUS + ALL', () => {
    const { aggregateOps } = planAggregation([obs()], 'EMERALD', new Map(), AT);
    const buckets = new Set(aggregateOps.map((o) => o.updateOne.update.$set.rankBucket));
    expect(buckets).toEqual(new Set(['EMERALD_PLUS', 'ALL']));
  });

  it('a blank role folds only into role="ALL"', () => {
    const { aggregateOps } = planAggregation([obs({ role: '' })], 'EMERALD', new Map(), AT);
    expect(new Set(aggregateOps.map((o) => o.updateOne.update.$set.role))).toEqual(new Set(['ALL']));
  });

  it('builds the nested $inc paths for a full observation', () => {
    const { aggregateOps } = planAggregation([obs()], 'MASTER', new Map(), AT);
    const inc = aggregateOps[0].updateOne.update.$inc;
    const pk = '3031-6672-3172';
    expect(inc).toMatchObject({
      games: 1,
      wins: 1,
      [`itemPaths.${pk}.games`]: 1,
      [`itemPaths.${pk}.wins`]: 1,
      [`itemPaths.${pk}.skills.Q~1-1-1-1-1`]: 1,
      [`itemPaths.${pk}.spells.4-7`]: 1,
      [`itemPaths.${pk}.starts.1055`]: 1,
    });
    expect(Object.keys(inc).some((k) => k.includes('.runes.'))).toBe(true);
  });

  it('a loss increments games but not wins', () => {
    const { aggregateOps } = planAggregation([obs({ win: false })], 'MASTER', new Map(), AT);
    expect(aggregateOps[0].updateOne.update.$inc.games).toBe(1);
    expect(aggregateOps[0].updateOne.update.$inc.wins).toBe(0);
  });

  it('drops a new item-path key when the map is at MAX_FREQ_KEYS, still counts the cell', () => {
    const fullItemPaths: AggregateDoc['itemPaths'] = {};
    for (let i = 0; i < MAX_FREQ_KEYS; i += 1) fullItemPaths[`x${String(i)}`] = { games: 1 };
    const existing = new Map<string, AggregateDoc>([
      ['Jinx|BOTTOM|EMERALD_PLUS|world|16.17', { _id: 'x', itemPaths: fullItemPaths }],
    ]);

    const op = planAggregation([obs()], 'EMERALD', existing, AT).aggregateOps.find(
      (o) => o.updateOne.filter._id === 'Jinx|BOTTOM|EMERALD_PLUS|world|16.17',
    );
    expect(op?.updateOne.update.$inc).toEqual({ games: 1, wins: 1 }); // no itemPaths.* paths
  });

  it('keeps incrementing an item-path key that already exists at cap', () => {
    const fullItemPaths: AggregateDoc['itemPaths'] = { '3031-6672-3172': { games: 5 } };
    for (let i = 0; i < MAX_FREQ_KEYS - 1; i += 1) fullItemPaths[`x${String(i)}`] = { games: 1 };
    const existing = new Map<string, AggregateDoc>([
      ['Jinx|BOTTOM|EMERALD_PLUS|world|16.17', { _id: 'x', itemPaths: fullItemPaths }],
    ]);
    const op = planAggregation([obs()], 'EMERALD', existing, AT).aggregateOps.find(
      (o) => o.updateOne.filter._id === 'Jinx|BOTTOM|EMERALD_PLUS|world|16.17',
    );
    expect(op?.updateOne.update.$inc['itemPaths.3031-6672-3172.games']).toBe(1);
  });

  it('empty observations -> no ops', () => {
    expect(planAggregation([], 'DIAMOND', new Map(), AT)).toEqual({ aggregateOps: [], totalsOps: [] });
  });
});

describe('createAggregator.fold', () => {
  function fakeDb(processedHas: string | null) {
    const bulk = vi.fn().mockResolvedValue(undefined);
    const insertOne = vi.fn().mockResolvedValue(undefined);
    const db = {
      collection: (name: string) => {
        if (name === 'crawl_processed') {
          return {
            findOne: vi.fn().mockResolvedValue(processedHas === null ? null : { _id: processedHas }),
            insertOne,
          };
        }
        return {
          find: () => ({ toArray: () => Promise.resolve([]) }),
          bulkWrite: bulk,
        };
      },
    } as unknown as Db;
    return { db, bulk, insertOne };
  }

  it('is a no-op when the match is already processed', async () => {
    const { db, bulk, insertOne } = fakeDb('EUW1_1');
    await createAggregator({ db, now: () => 0 }).fold([obs()], 'EUW1_1', 'DIAMOND');
    expect(bulk).not.toHaveBeenCalled();
    expect(insertOne).not.toHaveBeenCalled();
  });

  it('writes the aggregate + totals bulk ops and the processed marker on a fresh match', async () => {
    const { db, bulk, insertOne } = fakeDb(null);
    await createAggregator({ db, now: () => 1 }).fold([obs()], 'EUW1_2', 'DIAMOND');
    expect(bulk).toHaveBeenCalledTimes(2); // aggregates + totals
    expect(insertOne).toHaveBeenCalledWith({ _id: 'EUW1_2', processedAt: expect.any(Date) });
  });

  it('swallows a duplicate-key error on the processed insert', async () => {
    const { db } = fakeDb(null);
    const agg = createAggregator({ db, now: () => 1 });
    // re-point insertOne to reject with a dup-key error
    (db.collection('crawl_processed').insertOne as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('E11000 duplicate key error'),
    );
    await expect(agg.fold([obs()], 'EUW1_3', 'DIAMOND')).resolves.toBeUndefined();
  });
});
