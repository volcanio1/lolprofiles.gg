/**
 * champion-build-stats-pipeline: refresh the pool of ranked seed players by
 * walking the League-V4 ladders (task 12).
 *
 * `refreshIfStale()` is a no-op unless the freshest `crawl_seeds` entry is older
 * than `SEED_TTL_MS`. It walks, per platform in `SEED_PLATFORMS`: the three apex
 * lists (Challenger / Grandmaster / Master) and paged Emerald + Diamond entries
 * (all four divisions). Every call goes through the Crawl_Gate. A failing ladder
 * call is counted and skipped; a `rate_limited` result stops the refresh and is
 * surfaced so the worker can abandon the whole cycle (Requirement 7.3).
 *
 * Each entry is upserted as `{ _id: puuid, tier, platform, refreshedAt }` — the
 * raw League-V4 tier is stored; the aggregator derives the buckets a match rolls
 * into via `bucketsForTier`.
 */

import type { Db } from 'mongodb';
import type { ApexTier, LadderSource, RankedQueueKey } from '../../riotApiClient';
import type { PlatformRoutingValue } from '../../region';
import type { CrawlGate } from './crawlGate';
import {
  CRAWL_SEEDS_COLLECTION,
  MAX_SEED_ENTRIES_PER_REFRESH,
  SEED_PLATFORMS,
  SEED_TTL_MS,
} from './constants';

const QUEUE: RankedQueueKey = 'RANKED_SOLO_5x5';
const APEX: readonly { method: ApexTier; tier: string }[] = [
  { method: 'challenger', tier: 'CHALLENGER' },
  { method: 'grandmaster', tier: 'GRANDMASTER' },
  { method: 'master', tier: 'MASTER' },
];
const PAGED: readonly { tier: string; divisions: readonly ('I' | 'II' | 'III' | 'IV')[] }[] = [
  { tier: 'EMERALD', divisions: ['I', 'II', 'III', 'IV'] },
  { tier: 'DIAMOND', divisions: ['I', 'II', 'III', 'IV'] },
];

export interface SeedSummary {
  skipped: boolean;
  entriesUpserted: number;
  failedCalls: number;
  /** A crawler call hit the shared rate limit — the worker should abandon the cycle. */
  rateLimited: boolean;
}

export interface Seeder {
  refreshIfStale(): Promise<SeedSummary>;
}

interface SeedDoc {
  _id: string;
  tier: string;
  platform: string;
  refreshedAt: Date;
}

export function createSeeder(deps: {
  client: LadderSource;
  gate: CrawlGate;
  db: Db;
  now: () => number;
}): Seeder {
  const seeds = deps.db.collection<SeedDoc>(CRAWL_SEEDS_COLLECTION);

  return {
    async refreshIfStale(): Promise<SeedSummary> {
      const newest = await seeds.find().sort({ refreshedAt: -1 }).limit(1).next();
      if (newest !== null && deps.now() - newest.refreshedAt.getTime() < SEED_TTL_MS) {
        return { skipped: true, entriesUpserted: 0, failedCalls: 0, rateLimited: false };
      }

      const at = new Date(deps.now());
      let entriesUpserted = 0;
      let failedCalls = 0;
      const pending: SeedDoc[] = [];

      const flush = async (): Promise<void> => {
        if (pending.length === 0) return;
        await seeds.bulkWrite(
          pending.map((doc) => ({
            updateOne: {
              filter: { _id: doc._id },
              update: { $set: { tier: doc.tier, platform: doc.platform, refreshedAt: doc.refreshedAt } },
              upsert: true,
            },
          })),
          { ordered: false },
        );
        entriesUpserted += pending.length;
        pending.length = 0;
      };

      const take = (puuids: readonly string[], tier: string, platform: string): boolean => {
        for (const puuid of puuids) {
          if (typeof puuid !== 'string' || puuid.length === 0) continue;
          pending.push({ _id: puuid, tier, platform, refreshedAt: at });
          if (entriesUpserted + pending.length >= MAX_SEED_ENTRIES_PER_REFRESH) {
            return true; // budget reached
          }
        }
        return false;
      };

      for (const platform of SEED_PLATFORMS) {
        const p = platform as PlatformRoutingValue;

        for (const { method, tier } of APEX) {
          await deps.gate.acquire();
          const result = await deps.client.getLeagueApex(p, method, QUEUE);
          if (result.kind === 'rate_limited') {
            await flush();
            return { skipped: false, entriesUpserted, failedCalls, rateLimited: true };
          }
          if (result.kind !== 'ok') {
            failedCalls += 1;
            continue;
          }
          if (take(result.data.entries.map((e) => e.puuid), tier, platform)) {
            await flush();
            return { skipped: false, entriesUpserted, failedCalls, rateLimited: false };
          }
        }

        for (const { tier, divisions } of PAGED) {
          for (const division of divisions) {
            for (let page = 1; ; page += 1) {
              await deps.gate.acquire();
              const result = await deps.client.getLeagueEntriesPage(p, QUEUE, tier, division, page);
              if (result.kind === 'rate_limited') {
                await flush();
                return { skipped: false, entriesUpserted, failedCalls, rateLimited: true };
              }
              if (result.kind !== 'ok') {
                failedCalls += 1;
                break;
              }
              if (result.data.length === 0) {
                break; // past the last page
              }
              if (take(result.data.map((e) => e.puuid), tier, platform)) {
                await flush();
                return { skipped: false, entriesUpserted, failedCalls, rateLimited: false };
              }
            }
          }
        }
      }

      await flush();
      return { skipped: false, entriesUpserted, failedCalls, rateLimited: false };
    },
  };
}
