import { describe, it, expect } from 'vitest';
import type { Db } from 'mongodb';
import type { LadderSource, RiotApiResult, LeagueLadderEntryDto, LeagueListDto } from '../../riotApiClient';
import { MAX_SEED_ENTRIES_PER_REFRESH, SEED_TTL_MS } from './constants';
import { createSeeder } from './seeder';

const gate = { acquire: () => Promise.resolve() };
const ok = <T>(data: T): RiotApiResult<T> => ({ kind: 'ok', data });

/** A fake `crawl_seeds` collection backed by a Map, plus a preset "newest" doc. */
function fakeSeeds(newestRefreshedAt: number | null) {
  const byId = new Map<string, { _id: string; tier: string; platform: string; refreshedAt: Date }>();
  const collection = {
    find: () => ({
      sort: () => ({
        limit: () => ({
          next: () =>
            Promise.resolve(
              newestRefreshedAt === null
                ? null
                : { _id: 'n', tier: 'MASTER', platform: 'euw1', refreshedAt: new Date(newestRefreshedAt) },
            ),
        }),
      }),
    }),
    bulkWrite: (ops: { updateOne: { filter: { _id: string }; update: { $set: Record<string, unknown> } } }[]) => {
      for (const op of ops) {
        byId.set(op.updateOne.filter._id, {
          _id: op.updateOne.filter._id,
          ...(op.updateOne.update.$set as { tier: string; platform: string; refreshedAt: Date }),
        });
      }
      return Promise.resolve(undefined);
    },
  };
  return { byId, db: { collection: () => collection } as unknown as Db };
}

interface LadderStub {
  apex?: (tier: string, platform: string) => RiotApiResult<LeagueListDto>;
  entries?: (tier: string, division: string, page: number, platform: string) => RiotApiResult<LeagueLadderEntryDto[]>;
}

function fakeClient(stub: LadderStub): LadderSource {
  const entry = (puuid: string): LeagueLadderEntryDto => ({ puuid, leaguePoints: 0, wins: 0, losses: 0 });
  return {
    getLeagueApex: (platform, method) =>
      Promise.resolve(
        stub.apex?.(method.toUpperCase(), platform) ??
          ok({ tier: method.toUpperCase(), queue: 'RANKED_SOLO_5x5', entries: [entry(`${platform}-${method}`)] }),
      ),
    getLeagueEntriesPage: (platform, _q, tier, division, page) =>
      Promise.resolve(
        stub.entries?.(tier, division, page, platform) ??
          (page === 1 ? ok([entry(`${platform}-${tier}-${division}-1`)]) : ok([])),
      ),
  };
}

describe('createSeeder.refreshIfStale', () => {
  it('skips when the freshest seed is within SEED_TTL_MS', async () => {
    const { db } = fakeSeeds(1_000_000);
    const client = fakeClient({});
    const summary = await createSeeder({ client, gate, db, now: () => 1_000_000 + SEED_TTL_MS - 1 }).refreshIfStale();
    expect(summary).toEqual({ skipped: true, entriesUpserted: 0, failedCalls: 0, rateLimited: false });
  });

  it('walks apex + Emerald/Diamond pages and upserts the union, tagged with tier + platform', async () => {
    const { byId, db } = fakeSeeds(null);
    const summary = await createSeeder({ client: fakeClient({}), gate, db, now: () => 5_000 }).refreshIfStale();

    expect(summary.skipped).toBe(false);
    expect(summary.entriesUpserted).toBe(byId.size);
    // 3 platforms × (3 apex + 2 tiers × 4 divisions × 1 page) = 3 × 11 = 33 entries
    expect(byId.size).toBe(33);
    const sample = byId.get('kr-challenger');
    expect(sample).toMatchObject({ tier: 'CHALLENGER', platform: 'kr' });
    expect(byId.get('na1-DIAMOND-III-1')).toMatchObject({ tier: 'DIAMOND', platform: 'na1' });
  });

  it('counts a failing ladder call and continues', async () => {
    const { byId, db } = fakeSeeds(null);
    const client = fakeClient({
      apex: (tier, platform) =>
        tier === 'MASTER' && platform === 'euw1'
          ? ({ kind: 'server_error', status: 503 } as RiotApiResult<LeagueListDto>)
          : ok({ tier, queue: 'RANKED_SOLO_5x5', entries: [{ puuid: `${platform}-${tier}`, leaguePoints: 0, wins: 0, losses: 0 }] }),
    });
    const summary = await createSeeder({ client, gate, db, now: () => 5_000 }).refreshIfStale();
    expect(summary.failedCalls).toBe(1);
    expect(byId.size).toBeGreaterThan(0);
  });

  it('surfaces rateLimited and stops immediately', async () => {
    const { byId, db } = fakeSeeds(null);
    const client = fakeClient({
      apex: (tier) =>
        tier === 'GRANDMASTER'
          ? ({ kind: 'rate_limited' } as RiotApiResult<LeagueListDto>)
          : ok({ tier, queue: 'RANKED_SOLO_5x5', entries: [{ puuid: `p-${tier}`, leaguePoints: 0, wins: 0, losses: 0 }] }),
    });
    const summary = await createSeeder({ client, gate, db, now: () => 5_000 }).refreshIfStale();
    expect(summary.rateLimited).toBe(true);
    // stopped after CHALLENGER on the first platform
    expect(byId.size).toBe(1);
  });

  it('stops at MAX_SEED_ENTRIES_PER_REFRESH', async () => {
    const { byId, db } = fakeSeeds(null);
    const client = fakeClient({
      apex: (tier, platform) =>
        ok({
          tier,
          queue: 'RANKED_SOLO_5x5',
          entries: Array.from({ length: MAX_SEED_ENTRIES_PER_REFRESH }, (_, i) => ({
            puuid: `${platform}-${tier}-${String(i)}`,
            leaguePoints: 0,
            wins: 0,
            losses: 0,
          })),
        }),
    });
    const summary = await createSeeder({ client, gate, db, now: () => 5_000 }).refreshIfStale();
    expect(summary.entriesUpserted).toBe(MAX_SEED_ENTRIES_PER_REFRESH);
    expect(byId.size).toBe(MAX_SEED_ENTRIES_PER_REFRESH);
  });

  it('a re-seed updates a moved player’s tier', async () => {
    const { byId, db } = fakeSeeds(null);
    const only = (atTier: string) =>
      fakeClient({
        apex: (tier) =>
          ok({
            tier,
            queue: 'RANKED_SOLO_5x5',
            entries: tier === atTier ? [{ puuid: 'shared', leaguePoints: 0, wins: 0, losses: 0 }] : [],
          }),
        entries: () => ok([]),
      });

    await createSeeder({ client: only('CHALLENGER'), gate, db, now: () => 1 }).refreshIfStale();
    expect(byId.get('shared')?.tier).toBe('CHALLENGER');

    await createSeeder({ client: only('MASTER'), gate, db, now: () => 2 }).refreshIfStale();
    expect(byId.get('shared')?.tier).toBe('MASTER');
  });
});
