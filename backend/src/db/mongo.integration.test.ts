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
import type { ProfileReport } from '../orchestrator';
import type { MatchDto } from '../riotApiClient';
import {
  MATCH_DETAIL_TTL_SECONDS,
  MATCH_DETAILS_COLLECTION,
  PROFILE_REPORT_TTL_SECONDS,
  PROFILE_REPORTS_COLLECTION,
} from './collections';
import { ensureIndexes } from './client';
import { MongoRankHistoryStore, type RankSnapshot } from './rankHistoryStore';
import { MongoRankCheckpointStore, type RankCheckpoint } from './rankCheckpointStore';
import { MongoLookedUpPlayerStore, type LookedUpPlayer } from './lookedUpPlayerStore';
import { MongoProfileSnapshotStore } from './profileSnapshotStore';
import { MongoMatchStore, type StoredMatch } from './matchStore';

const TEST_URI = process.env.MONGODB_TEST_URI;
const DAY_MS = 86_400_000;
const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 7, 28, 12, 0, 0);

function snap(overrides: Partial<RankSnapshot> = {}): RankSnapshot {
  return {
    puuid: 'p1',
    queueType: 'RANKED_SOLO_5x5',
    tier: 'GOLD',
    division: 'II',
    leaguePoints: 40,
    gamesPlayed: 0,
    observedAt: BASE,
    ...overrides,
  };
}

function checkpoint(overrides: Partial<RankCheckpoint> = {}): RankCheckpoint {
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

  it('skips a re-record when the same rank has not moved 3 games on', async () => {
    const store = new MongoRankHistoryStore(db);

    await store.record(snap({ leaguePoints: 40, gamesPlayed: 100, observedAt: BASE }));
    await store.record(snap({ leaguePoints: 43, gamesPlayed: 102, observedAt: BASE + 3_600_000 }));

    const history = await store.history('p1', 'RANKED_SOLO_5x5');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ leaguePoints: 40 });
  });

  it('records again once 3+ games have been played and reads back oldest-first', async () => {
    const store = new MongoRankHistoryStore(db);
    const puuid = `games-${Date.now()}`;

    await store.record(snap({ puuid, observedAt: BASE, leaguePoints: 1, gamesPlayed: 10 }));
    await store.record(snap({ puuid, observedAt: BASE + DAY_MS, leaguePoints: 2, gamesPlayed: 14 }));
    await store.record(snap({ puuid, observedAt: BASE + 2 * DAY_MS, leaguePoints: 3, gamesPlayed: 19 }));

    const history = await store.history(puuid, 'RANKED_SOLO_5x5');
    expect(history.map((s) => s.leaguePoints)).toEqual([1, 2, 3]);
  });

  it('deleteByPuuid clears every snapshot for the player', async () => {
    const store = new MongoRankHistoryStore(db);
    const puuid = `del-${Date.now()}`;

    await store.record(snap({ puuid, observedAt: BASE, gamesPlayed: 10 }));
    await store.record(snap({ puuid, observedAt: BASE + DAY_MS, gamesPlayed: 20 }));

    expect(await store.deleteByPuuid(puuid)).toBe(2);
    expect(await store.history(puuid, 'RANKED_SOLO_5x5')).toEqual([]);
  });

  it('rank checkpoints: keeps each game-count change, drops a same-count repeat, oldest first', async () => {
    const store = new MongoRankCheckpointStore(db);
    const puuid = `checkpoint-${Date.now()}`;

    await store.record(checkpoint({ puuid, leaguePoints: 40, wins: 30, losses: 25, observedAt: BASE }));
    await store.record(checkpoint({ puuid, leaguePoints: 55, wins: 30, losses: 25, observedAt: BASE + HOUR })); // dropped
    await store.record(checkpoint({ puuid, leaguePoints: 58, wins: 31, losses: 25, observedAt: BASE + 2 * HOUR }));

    const history = await store.historyAll(puuid);
    expect(history.map((c) => c.leaguePoints)).toEqual([40, 58]);
    expect(history[0]).toMatchObject({ wins: 30, losses: 25 });
    expect(history[1]).toMatchObject({ wins: 31, losses: 25 });
  });

  it('rank checkpoint deleteByPuuid clears every checkpoint across queues for the player', async () => {
    const store = new MongoRankCheckpointStore(db);
    const puuid = `checkpoint-del-${Date.now()}`;

    await store.record(checkpoint({ puuid, observedAt: BASE }));
    await store.record(checkpoint({ puuid, queueType: 'RANKED_FLEX_SR', observedAt: BASE }));

    expect(await store.deleteByPuuid(puuid)).toBe(2);
    expect(await store.historyAll(puuid)).toEqual([]);
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

  it('findByRiotId matches gameName + tagLine exactly and case-insensitively', async () => {
    const store = new MongoLookedUpPlayerStore(db);
    const tag = `fbr${Date.now()}`;
    await store.remember(player({ puuid: `${tag}-a`, gameName: tag, tagLine: 'KR1', lastLookedUpAt: 1 }));
    await store.remember(player({ puuid: `${tag}-b`, gameName: tag, tagLine: 'EUW', lastLookedUpAt: 2 }));

    expect((await store.findByRiotId(tag.toUpperCase(), 'kr1'))?.puuid).toBe(`${tag}-a`);
    expect((await store.findByRiotId(tag, 'EUW'))?.puuid).toBe(`${tag}-b`);
    expect(await store.findByRiotId(tag, 'NA1')).toBeNull();
  });

  it('profile_reports carries a 15-day TTL index on fetchedAt', async () => {
    const indexes = await db.collection(PROFILE_REPORTS_COLLECTION).indexes();
    const ttl = indexes.find((i) => i.name === 'ttl_fetchedAt');
    expect(ttl).toBeDefined();
    expect(ttl?.expireAfterSeconds).toBe(PROFILE_REPORT_TTL_SECONDS);
  });

  it('the profile snapshot store upserts by puuid and round-trips fetchedAt', async () => {
    const store = new MongoProfileSnapshotStore(db);
    const puuid = `snap-${Date.now()}`;
    const report = (level: number) =>
      ({ puuid, riotId: { gameName: 'Faker', tagLine: 'KR1' }, summonerLevel: level }) as ProfileReport;

    await store.save(puuid, report(1), 1_000);
    await store.save(puuid, report(2), 2_000);

    const stored = await store.get(puuid);
    expect(stored?.fetchedAt).toBe(2_000);
    expect(stored?.report).toMatchObject({ summonerLevel: 2 });

    expect(await store.deleteByPuuid(puuid)).toBe(1);
    expect(await store.get(puuid)).toBeNull();
  });

  it('match_details carries a 150-day TTL index and a participants index (specs/match-cache/)', async () => {
    const indexes = await db.collection(MATCH_DETAILS_COLLECTION).indexes();
    const ttl = indexes.find((i) => i.name === 'ttl_storedAt');
    expect(ttl?.expireAfterSeconds).toBe(MATCH_DETAIL_TTL_SECONDS);
    expect(indexes.find((i) => i.name === 'participants')).toBeDefined();
  });

  it('the match store upserts by matchId, round-trips getMany, and evicts by participant', async () => {
    const store = new MongoMatchStore(db);
    const run = Date.now();
    const dto = (matchId: string, participants: string[]): MatchDto => ({
      metadata: { matchId, participants },
      info: { queueId: 420, gameStartTimestamp: BASE, gameDuration: 1800, participants: [] },
    });
    const rec = (matchId: string, participants: string[], storedAt: number): StoredMatch => ({
      matchId,
      match: dto(matchId, participants),
      region: 'americas',
      storedAt,
    });

    await store.putMany([
      rec(`${run}_1`, [`${run}-victim`, `${run}-bystander`], 1_000),
      rec(`${run}_2`, [`${run}-bystander`], 2_000),
    ]);
    // upsert, not fork
    await store.putMany([rec(`${run}_1`, [`${run}-victim`, `${run}-bystander`], 9_000)]);

    const got = await store.getMany([`${run}_1`, `${run}_2`, `${run}_absent`]);
    expect([...got.keys()].sort()).toEqual([`${run}_1`, `${run}_2`].sort());
    expect(got.get(`${run}_1`)?.storedAt).toBe(9_000);
    expect(got.get(`${run}_1`)?.match.metadata.participants).toContain(`${run}-victim`);

    expect(await store.deleteByPuuid(`${run}-victim`)).toBe(1);
    expect((await store.getMany([`${run}_1`])).size).toBe(0);
    expect((await store.getMany([`${run}_2`])).size).toBe(1); // bystander-only match kept
  });

  it('the match store getMany resolves empty rather than rejecting when its read deadline elapses', async () => {
    const matchId = `to-${Date.now()}`;
    await new MongoMatchStore(db).putMany([
      {
        matchId,
        match: { metadata: { matchId, participants: [] }, info: { queueId: 420, gameStartTimestamp: BASE, gameDuration: 1, participants: [] } },
        region: 'americas',
        storedAt: 1,
      },
    ]);

    // A scheduler that fires the deadline immediately — it always wins the race
    // against a real round trip, so getMany degrades to "nothing stored".
    const store = new MongoMatchStore(db, {
      scheduleTimeout: (_ms, onElapsed) => {
        onElapsed();
        return () => {};
      },
    });

    const result = await store.getMany([matchId]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });
});
