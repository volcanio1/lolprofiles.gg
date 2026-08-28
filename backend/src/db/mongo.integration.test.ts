/**
 * specs/database/ task 2.4 — opt-in integration tests against a real MongoDB.
 *
 * Skipped unless `MONGODB_TEST_URI` is set, so `npm test` never needs a database
 * (Requirement 8.3). Point it at a local `mongod` or a scratch Atlas cluster:
 *
 *   MONGODB_TEST_URI='mongodb://localhost:27017' npx vitest run src/db/mongo.integration.test.ts
 *
 * Each run uses a uniquely-named database and drops it in teardown, so it never
 * touches the real `lolprofiles` database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { ensureIndexes } from './client';
import { MongoRankHistoryStore, type RankSnapshot } from './rankHistoryStore';
import { MongoLookedUpPlayerStore, type LookedUpPlayer } from './lookedUpPlayerStore';

const TEST_URI = process.env.MONGODB_TEST_URI;
const DAY_MS = 86_400_000;
const BASE = Date.UTC(2026, 7, 28, 12, 0, 0);

function snap(overrides: Partial<RankSnapshot> = {}): RankSnapshot {
  return {
    puuid: 'p1',
    queueType: 'RANKED_SOLO_5x5',
    tier: 'GOLD',
    division: 'II',
    leaguePoints: 40,
    observedAt: BASE,
    ...overrides,
  };
}

function player(overrides: Partial<LookedUpPlayer> = {}): LookedUpPlayer {
  return {
    puuid: 'p1',
    gameName: 'Faker',
    tagLine: 'KR1',
    profileIconId: 6,
    region: 'kr',
    lastLookedUpAt: 1_000,
    ...overrides,
  };
}

describe.skipIf(!TEST_URI)('MongoDB integration', () => {
  let client: MongoClient;
  let db: Db;
  let dbName: string;

  beforeAll(async () => {
    client = new MongoClient(TEST_URI as string, { serverSelectionTimeoutMS: 8_000 });
    await client.connect();
    dbName = `lolprofiles_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    db = client.db(dbName);
    await ensureIndexes(db);
  });

  afterAll(async () => {
    if (db) {
      await db.dropDatabase();
    }
    if (client) {
      await client.close();
    }
  });

  it('the unique index makes a same-day re-record a silent no-op', async () => {
    const store = new MongoRankHistoryStore(db);

    await store.record(snap({ leaguePoints: 40, observedAt: BASE }));
    await store.record(snap({ leaguePoints: 99, tier: 'PLATINUM', observedAt: BASE + 3_600_000 }));

    const history = await store.history('p1', 'RANKED_SOLO_5x5');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ leaguePoints: 40, tier: 'GOLD' });
  });

  it('records once per UTC day and reads back oldest-first', async () => {
    const store = new MongoRankHistoryStore(db);
    const puuid = `day-roll-${Date.now()}`;

    await store.record(snap({ puuid, observedAt: BASE + 2 * DAY_MS, leaguePoints: 3 }));
    await store.record(snap({ puuid, observedAt: BASE, leaguePoints: 1 }));
    await store.record(snap({ puuid, observedAt: BASE + DAY_MS, leaguePoints: 2 }));

    const history = await store.history(puuid, 'RANKED_SOLO_5x5');
    expect(history.map((s) => s.leaguePoints)).toEqual([1, 2, 3]);
  });

  it('deleteByPuuid clears every snapshot for the player', async () => {
    const store = new MongoRankHistoryStore(db);
    const puuid = `del-${Date.now()}`;

    await store.record(snap({ puuid, observedAt: BASE }));
    await store.record(snap({ puuid, observedAt: BASE + DAY_MS }));

    expect(await store.deleteByPuuid(puuid)).toBe(2);
    expect(await store.history(puuid, 'RANKED_SOLO_5x5')).toEqual([]);
  });

  it('remember upserts by puuid and the prefix scan returns recency order', async () => {
    const store = new MongoLookedUpPlayerStore(db);
    const tag = `pfx${Date.now()}`;

    await store.remember(player({ puuid: 'a', gameName: `${tag}_older`, lastLookedUpAt: 100 }));
    await store.remember(player({ puuid: 'b', gameName: `${tag}_newer`, lastLookedUpAt: 500 }));
    // Upsert, not fork:
    await store.remember(player({ puuid: 'a', gameName: `${tag}_older`, profileIconId: 77, lastLookedUpAt: 900 }));

    const rows = await store.searchByNamePrefix(tag.toUpperCase(), 10);
    expect(rows.map((r) => r.puuid)).toEqual(['a', 'b']);
    expect(rows[0].profileIconId).toBe(77);
  });

  it('a regex-metacharacter prefix is matched literally', async () => {
    const store = new MongoLookedUpPlayerStore(db);
    const uniq = `rx${Date.now()}`;

    await store.remember(player({ puuid: `${uniq}-1`, gameName: `${uniq}.b`, lastLookedUpAt: 1 }));
    await store.remember(player({ puuid: `${uniq}-2`, gameName: `${uniq}Xb`, lastLookedUpAt: 2 }));

    const rows = await store.searchByNamePrefix(`${uniq}.`, 10);
    expect(rows.map((r) => r.gameName)).toEqual([`${uniq}.b`]);
  });

  it('deleteByPuuid on the player store returns 1 then 0', async () => {
    const store = new MongoLookedUpPlayerStore(db);
    await store.remember(player({ puuid: 'to-delete', gameName: 'ZZDelete', lastLookedUpAt: 1 }));

    expect(await store.deleteByPuuid('to-delete')).toBe(1);
    expect(await store.deleteByPuuid('to-delete')).toBe(0);
  });
});
