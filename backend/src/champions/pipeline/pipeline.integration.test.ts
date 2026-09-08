/**
 * champion-build-stats-pipeline: end-to-end MongoDB integration (tasks 10.3,
 * 11.2, 13.4). Skipped unless `MONGODB_TEST_URI` is set — the rest of the suite
 * never needs a database.
 *
 *   MONGODB_TEST_URI='mongodb://localhost:27017' npx vitest run src/champions/pipeline/pipeline.integration.test.ts
 *
 * Verified green against the real Atlas M0 (2026-09-08). Each run uses a
 * uniquely-named database and drops its collections in teardown (Atlas M0
 * forbids `dropDatabase` for the app user; an empty collection-less database is
 * invisible anyway).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import type { RunePage } from '../../insight/stats';
import { ensureIndexes } from '../../db/client';
import { MongoChampionStatsStore } from '../../db/championStatsStore';
import { createAggregator } from './aggregator';
import type { Observation } from './extractor';
import {
  serializeItemPath,
  serializeRunePage,
  serializeSkillOrder,
  serializeSpellPair,
  serializeStartingItems,
} from './serialize';
import {
  CHAMPION_BUILD_AGGREGATES_COLLECTION,
  CHAMPION_BUILD_TOTALS_COLLECTION,
  CRAWL_PROCESSED_COLLECTION,
} from './constants';

const TEST_URI = process.env.MONGODB_TEST_URI;

const RUNES: RunePage = {
  primaryStyle: 8100,
  secondaryStyle: 8000,
  primarySelections: [8112, 8126, 8138, 8135],
  secondarySelections: [9111, 8014],
  statShards: [5008, 5008, 5001],
};

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    championKey: 'Jinx',
    role: 'BOTTOM',
    win: true,
    patch: '16.17',
    itemPath: [3031, 6672, 3172],
    startingItems: [1055],
    skillOrder: { maxOrder: ['Q'], perLevel: [1, 1, 1, 1, 1] },
    runePage: RUNES,
    spellPair: [4, 7],
    ...overrides,
  };
}

describe.skipIf(!TEST_URI)('champion-build-stats-pipeline — MongoDB integration', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = new MongoClient(TEST_URI as string, { serverSelectionTimeoutMS: 10_000 });
    await client.connect();
    db = client.db(`lp_pltest_${Math.random().toString(36).slice(2, 12)}`); // Atlas caps db names at 38 bytes
    await ensureIndexes(db);
  });

  afterAll(async () => {
    // Atlas M0 forbids dropDatabase for this user; dropping each collection works.
    if (db) {
      for (const { name } of await db.listCollections().toArray()) {
        await db.dropCollection(name).catch(() => undefined);
      }
    }
    if (client) await client.close();
  });

  it('aggregator folds one match into the right cells + totals + processed marker, and a re-fold is a no-op', async () => {
    const aggregator = createAggregator({ db, now: () => 1_700_000_000_000 });

    await aggregator.fold([observation()], 'EUW1_1', 'DIAMOND');

    const aggCol = db.collection<{ _id: string; games?: number; wins?: number; itemPaths?: Record<string, { games: number }> }>(CHAMPION_BUILD_AGGREGATES_COLLECTION);
    const cells = await aggCol.find({ championKey: 'Jinx' }).toArray();
    expect(cells.map((c) => c._id).sort()).toEqual(
      [
        'Jinx|ALL|ALL|world|16.17',
        'Jinx|ALL|DIAMOND_PLUS|world|16.17',
        'Jinx|ALL|EMERALD_PLUS|world|16.17',
        'Jinx|BOTTOM|ALL|world|16.17',
        'Jinx|BOTTOM|DIAMOND_PLUS|world|16.17',
        'Jinx|BOTTOM|EMERALD_PLUS|world|16.17',
      ].sort(),
    );
    const bottomEmerald = cells.find((c) => c._id === 'Jinx|BOTTOM|EMERALD_PLUS|world|16.17')!;
    expect(bottomEmerald.games).toBe(1);
    expect(bottomEmerald.wins).toBe(1);
    expect(bottomEmerald.itemPaths!['3031-6672-3172'].games).toBe(1);

    const totals = await db.collection<{ _id: string; matches: number }>(CHAMPION_BUILD_TOTALS_COLLECTION).find().toArray();
    expect(totals.map((t) => t._id).sort()).toEqual([
      'ALL|world|16.17',
      'DIAMOND_PLUS|world|16.17',
      'EMERALD_PLUS|world|16.17',
    ]);
    expect(totals[0].matches).toBe(1);

    expect(await db.collection(CRAWL_PROCESSED_COLLECTION).countDocuments()).toBe(1);

    // re-fold the same match -> no-op
    await aggregator.fold([observation()], 'EUW1_1', 'DIAMOND');
    const after = await aggCol.findOne({ _id: 'Jinx|BOTTOM|EMERALD_PLUS|world|16.17' });
    expect(after!.games).toBe(1);
  });

  it('MongoChampionStatsStore reads folded data back through the pure resolveBuilds', async () => {
    // A real fold (small sample) + a directly-seeded floor-clearing cell, so the
    // store's read path is exercised without 100+ Atlas round trips.
    await createAggregator({ db, now: () => 1_700_000_000_000 }).fold([observation()], 'KR_1', 'MASTER');

    const pk = serializeItemPath([3031, 6672, 3172]);
    await db.collection(CHAMPION_BUILD_AGGREGATES_COLLECTION).updateOne(
      { _id: 'Kaisa|BOTTOM|MASTER_PLUS|world|16.17' } as never,
      {
        $set: {
          championKey: 'Kaisa',
          role: 'BOTTOM',
          rankBucket: 'MASTER_PLUS',
          region: 'world',
          patch: '16.17',
          games: 900,
          wins: 500,
          lastUpdatedAt: new Date(1_700_000_100_000),
          [`itemPaths.${pk}`]: {
            games: 900,
            wins: 500,
            skills: { [serializeSkillOrder({ maxOrder: ['Q'], perLevel: [1, 1, 1, 1, 1] })]: 900 },
            runes: { [serializeRunePage(RUNES)]: 900 },
            spells: { [serializeSpellPair([4, 7])]: 900 },
            starts: { [serializeStartingItems([1055])]: 900 },
          },
        },
      },
      { upsert: true },
    );
    await db.collection(CHAMPION_BUILD_TOTALS_COLLECTION).updateOne(
      { _id: 'MASTER_PLUS|world|16.17' } as never,
      { $set: { rankBucket: 'MASTER_PLUS', region: 'world', patch: '16.17', matches: 4000 } },
      { upsert: true },
    );

    const store = new MongoChampionStatsStore(db);

    // the small real fold: known champion, below the display floor -> popular null, meta populated
    const jinx = await store.getBuildStats('Jinx', { role: 'BOTTOM', rank: 'MASTER_PLUS', region: 'world' });
    expect(jinx).not.toBeNull();
    expect(jinx?.meta.patch).toBe('16.17');
    expect(jinx?.meta.availableRoles).toContain('BOTTOM');
    expect(jinx?.meta.defaultRank).toBe('ALL');
    expect(jinx?.popular).toBeNull(); // 1 game < BACKEND_DISPLAY_FLOOR

    // the seeded floor-clearing cell -> deserialized back through resolveBuilds
    const kaisa = await store.getBuildStats('Kaisa', { role: 'BOTTOM', rank: 'MASTER_PLUS', region: 'world' });
    expect(kaisa?.popular?.coreItems).toEqual([3031, 6672, 3172]);
    expect(kaisa?.popular?.matchCount).toBe(900);
    expect(kaisa?.popular?.runes).toEqual(RUNES);
    expect(kaisa?.popular?.skillOrder).toEqual({ maxOrder: ['Q'], perLevel: [1, 1, 1, 1, 1] });
    expect(kaisa?.highestWinRate?.matchCount).toBe(900); // 900 >= MIN_SAMPLE (500)
    expect(kaisa?.highestWinRate?.winRate).toBeCloseTo(500 / 900);
    expect(kaisa?.meta.overall.pickRate).toBeCloseTo(900 / 4000);

    expect(await store.getBuildStats('Ashe', { role: 'BOTTOM', rank: 'MASTER_PLUS', region: 'world' })).toBeNull();
  }, 30_000);
});
