/**
 * champion-build-stats-pipeline: the background worker that runs the whole
 * pipeline on a timer (task 13). A sibling of clash-scouting's
 * `TournamentRefresher`.
 *
 * Per cycle: opportunistically prune old-patch docs -> refresh seeds if stale ->
 * take the next `seedsPerCycle` seed players -> per player fetch new queue-420
 * match ids -> per unprocessed match fetch detail + timeline -> extract -> fold
 * -> mark processed -> write `crawl_state` + a counts-only summary line.
 *
 * Every Riot call goes through the `CrawlGate` first. Any `{ kind:
 * 'rate_limited' }` abandons the cycle (Requirement 7.3). One `runCycle()` at a
 * time — a tick that fires while a cycle runs is dropped, not queued
 * (Requirement 1.2). Disabled (`!config.enabled` or `db === null`) -> `start()`
 * is inert (Requirement 1.3).
 *
 * NO cache — the crawl path never touches any cache (Requirement 3.7); it calls
 * the Riot client directly.
 */

import type { Db } from 'mongodb';
import type { LadderSource, RiotApiClient, RiotApiResult } from '../../riotApiClient';
import { regionForPlatform, type PlatformRoutingValue } from '../../region';
import type { RepeatingScheduler } from '../../clashScouting/tournamentRefresher';
import { extractObservations } from './extractor';
import { createAggregator } from './aggregator';
import { createSeeder } from './seeder';
import { createCrawlGate } from './crawlGate';
import {
  CHAMPION_BUILD_AGGREGATES_COLLECTION,
  CHAMPION_BUILD_TOTALS_COLLECTION,
  CRAWL_PROCESSED_COLLECTION,
  CRAWL_SEEDS_COLLECTION,
  CRAWL_STATE_COLLECTION,
  KEEP_PATCHES,
  RANKED_SOLO_QUEUE_ID,
} from './constants';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface CrawlWorkerConfig {
  enabled: boolean;
  intervalMs?: number;
  budgetFraction: number;
  rps: number;
  seedsPerCycle: number;
  matchesPerSeed: number;
}

export interface CycleSummary {
  seedsRefreshed: number;
  seedsProcessed: number;
  idsSeen: number;
  idsSkippedProcessed: number;
  matchesFetched: number;
  observationsFolded: number;
  riotCalls: number;
  endedEarly: boolean;
}

export interface CrawlLogger {
  /** One counts-only line per cycle (no puuid / riotId / key — Requirement 9.3). */
  cycle(summary: CycleSummary): void;
  cycleFailed(error: unknown): void;
}

const consoleCrawlLogger: CrawlLogger = {
  cycle(summary) {
    // eslint-disable-next-line no-console
    console.log('[lolprofiles] champion-build crawl cycle:', JSON.stringify(summary));
  },
  cycleFailed(error) {
    // eslint-disable-next-line no-console
    console.warn('[lolprofiles] champion-build crawl cycle failed:', error);
  },
};

export interface CrawlWorker {
  start(): void;
  stop(): void;
}

const defaultSchedule: RepeatingScheduler = (ms, run) => {
  const handle = setInterval(run, ms);
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as { unref: () => void }).unref();
  }
  return () => {
    clearInterval(handle);
  };
};

/** Thrown to unwind out of the nested crawl loops when the rate limit is hit. */
class RateCapReached extends Error {}

function comparePatchDesc(a: string, b: string): number {
  const [am = 0, an = 0] = a.split('.').map(Number);
  const [bm = 0, bn = 0] = b.split('.').map(Number);
  return bm - am || bn - an;
}

export function createCrawlWorker(deps: {
  client: RiotApiClient & LadderSource;
  db: Db | null;
  config: CrawlWorkerConfig;
  now?: () => number;
  schedule?: RepeatingScheduler;
  logger?: CrawlLogger;
}): CrawlWorker {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? defaultSchedule;
  const logger = deps.logger ?? consoleCrawlLogger;
  const intervalMs = deps.config.intervalMs ?? DEFAULT_INTERVAL_MS;
  const active = deps.config.enabled && deps.db !== null;

  let cancel: (() => void) | null = null;
  let running = false;

  async function runCycle(db: Db): Promise<CycleSummary> {
    const summary: CycleSummary = {
      seedsRefreshed: 0,
      seedsProcessed: 0,
      idsSeen: 0,
      idsSkippedProcessed: 0,
      matchesFetched: 0,
      observationsFolded: 0,
      riotCalls: 0,
      endedEarly: false,
    };

    const gate = createCrawlGate({ rps: deps.config.rps, fraction: deps.config.budgetFraction, now });
    const seeder = createSeeder({ client: deps.client, gate, db, now });
    const aggregator = createAggregator({ db, now });

    const aggregates = db.collection(CHAMPION_BUILD_AGGREGATES_COLLECTION);
    const totals = db.collection(CHAMPION_BUILD_TOTALS_COLLECTION);
    const processed = db.collection<{ _id: string }>(CRAWL_PROCESSED_COLLECTION);
    const seeds = db.collection<{ _id: string; tier: string; platform: string }>(CRAWL_SEEDS_COLLECTION);
    const crawlState = db.collection<{ _id: string; seedCursor?: number }>(CRAWL_STATE_COLLECTION);

    async function gated<T>(call: () => Promise<RiotApiResult<T>>): Promise<RiotApiResult<T>> {
      await gate.acquire();
      summary.riotCalls += 1;
      const result = await call();
      if (result.kind === 'rate_limited') {
        throw new RateCapReached();
      }
      return result;
    }

    // (a) opportunistic prune — best-effort, never fatal.
    try {
      const patches = (await aggregates.distinct('patch')) as string[];
      if (patches.length > KEEP_PATCHES) {
        const drop = [...patches].sort(comparePatchDesc).slice(KEEP_PATCHES);
        if (drop.length > 0) {
          await aggregates.deleteMany({ patch: { $in: drop } });
          await totals.deleteMany({ patch: { $in: drop } });
        }
      }
    } catch {
      // storage grows a little until the next successful prune — acceptable.
    }

    // (b) seeds
    const seedResult = await seeder.refreshIfStale();
    summary.seedsRefreshed = seedResult.entriesUpserted;
    if (seedResult.rateLimited) {
      summary.endedEarly = true;
      await writeState(null);
      return summary;
    }

    const total = await seeds.countDocuments();
    if (total === 0) {
      await writeState(null);
      return summary;
    }

    const state = await crawlState.findOne({ _id: 'singleton' });
    const cursor = ((state?.seedCursor ?? 0) % total + total) % total;

    const batch = await seeds
      .find()
      .sort({ _id: 1 })
      .skip(cursor)
      .limit(deps.config.seedsPerCycle)
      .toArray();

    const seenThisCycle = new Set<string>();
    let processedSeeds = 0;

    try {
      for (const seed of batch) {
        const region = regionForPlatform(seed.platform as PlatformRoutingValue);
        const ids = await gated(() =>
          deps.client.getMatchIdsByPuuid(region, seed._id, deps.config.matchesPerSeed, RANKED_SOLO_QUEUE_ID),
        );
        if (ids.kind !== 'ok') {
          // Still advance past this seed — a persistently-failing one must not stall the cursor.
          processedSeeds += 1;
          await writeState((cursor + processedSeeds) % total);
          continue;
        }
        summary.seedsProcessed += 1;
        summary.idsSeen += ids.data.length;

        const fresh = ids.data.filter((id) => !seenThisCycle.has(id));
        const already =
          fresh.length === 0
            ? new Set<string>()
            : new Set(
                (await processed.find({ _id: { $in: fresh } }).toArray()).map((doc) => doc._id),
              );

        for (const id of fresh) {
          seenThisCycle.add(id);
          if (already.has(id)) {
            summary.idsSkippedProcessed += 1;
            continue;
          }
          const detail = await gated(() => deps.client.getMatchById(region, id));
          if (detail.kind !== 'ok') {
            continue;
          }
          const timeline = await gated(() => deps.client.getMatchTimeline(region, id));
          if (timeline.kind !== 'ok') {
            continue;
          }
          summary.matchesFetched += 1;
          const observations = extractObservations(detail.data, timeline.data);
          if (observations.length > 0) {
            await aggregator.fold(observations, id, seed.tier);
            summary.observationsFolded += observations.length;
          }
        }

        // Advance the cursor per seed, not just at cycle end — so a cycle cut
        // short by a restart still makes forward progress and does not re-crawl
        // the same seeds forever.
        processedSeeds += 1;
        await writeState((cursor + processedSeeds) % total);
      }
    } catch (error) {
      if (!(error instanceof RateCapReached)) {
        throw error;
      }
      summary.endedEarly = true;
      await writeState((cursor + processedSeeds) % total);
      return summary;
    }

    await writeState((cursor + Math.max(processedSeeds, deps.config.seedsPerCycle)) % total);
    return summary;

    async function writeState(nextCursor: number | null): Promise<void> {
      const update: Record<string, unknown> = { lastCycleAt: new Date(now()), lastCycleSummary: summary };
      if (nextCursor !== null) {
        update.seedCursor = nextCursor;
      }
      await crawlState.updateOne({ _id: 'singleton' }, { $set: update }, { upsert: true }).catch(() => undefined);
    }
  }

  async function tick(): Promise<void> {
    if (running || deps.db === null) {
      return;
    }
    running = true;
    try {
      logger.cycle(await runCycle(deps.db));
    } catch (error) {
      logger.cycleFailed(error);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (!active || cancel !== null) {
        return;
      }
      void tick();
      cancel = schedule(intervalMs, () => {
        void tick();
      });
    },
    stop() {
      cancel?.();
      cancel = null;
    },
  };
}
