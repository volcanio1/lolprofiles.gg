/**
 * champion-build-stats-pipeline: fold one crawled match's Observations into the
 * aggregate + totals documents, then mark it processed (task 10).
 *
 * Given `region='world'` v1 and Ranked Solo draft (no duplicate champions in a
 * game), each `(championKey, role, rankBucket)` target is touched at most once
 * per `fold`, so there is no in-fold merge to do.
 *
 * The frequency sub-maps are capped at `MAX_FREQ_KEYS`: once a map is full an
 * unseen key's `$inc` is dropped (the cell's own `games`/`wins` still count, so
 * `cell.games` can exceed `Σ itemPaths.games` — inherent to any capped design,
 * documented). A single sequential crawl worker means the read-then-decide has
 * no real race.
 */

import type { Db } from 'mongodb';
import {
  CHAMPION_BUILD_AGGREGATES_COLLECTION,
  CHAMPION_BUILD_TOTALS_COLLECTION,
  CRAWL_PROCESSED_COLLECTION,
  MAX_FREQ_KEYS,
  bucketsForTier,
  type RankBucket,
} from './constants';
import type { Observation } from './extractor';
import {
  serializeItemPath,
  serializeRunePage,
  serializeSkillOrder,
  serializeSpellPair,
  serializeStartingItems,
} from './serialize';

const REGION = 'world';
const RANKED_ROLES = new Set(['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']);

export interface Aggregator {
  /** No-op if `matchId` is already processed. `seedTier` is the seed player's raw League-V4 tier. */
  fold(observations: readonly Observation[], matchId: string, seedTier: string): Promise<void>;
}

export interface AggregateDoc {
  _id: string;
  itemPaths?: Record<
    string,
    {
      games?: number;
      skills?: Record<string, number>;
      runes?: Record<string, number>;
      spells?: Record<string, number>;
      starts?: Record<string, number>;
    }
  >;
}

interface TotalsDoc {
  _id: string;
  matches?: number;
}

interface ProcessedDoc {
  _id: string;
  processedAt: Date;
}

function cellId(championKey: string, role: string, bucket: string, patch: string): string {
  return `${championKey}|${role}|${bucket}|${REGION}|${patch}`;
}

function atCap(map: Record<string, unknown> | undefined, key: string): boolean {
  if (map === undefined) {
    return false;
  }
  return map[key] === undefined && Object.keys(map).length >= MAX_FREQ_KEYS;
}

export interface CellUpsertOp {
  updateOne: {
    filter: { _id: string };
    update: { $inc: Record<string, number>; $set: Record<string, unknown> };
    upsert: true;
  };
}

/**
 * The pure core: from a match's Observations + the current state of every cell
 * doc it touches, compute the aggregate + totals bulk-write ops (with the
 * frequency-map cap applied). No I/O — `fold` reads the docs and writes the ops.
 */
export function planAggregation(
  observations: readonly Observation[],
  seedTier: string,
  existing: ReadonlyMap<string, AggregateDoc>,
  at: Date,
): { aggregateOps: CellUpsertOp[]; totalsOps: CellUpsertOp[] } {
  if (observations.length === 0) {
    return { aggregateOps: [], totalsOps: [] };
  }
  const buckets = bucketsForTier(seedTier);
  const patch = observations[0].patch;

  const targets: { id: string; obs: Observation; role: string; bucket: RankBucket }[] = [];
  for (const obs of observations) {
    const roles = RANKED_ROLES.has(obs.role) ? [obs.role, 'ALL'] : ['ALL'];
    for (const role of roles) {
      for (const bucket of buckets) {
        targets.push({ id: cellId(obs.championKey, role, bucket, patch), obs, role, bucket });
      }
    }
  }

  const aggregateOps = targets.map(({ id, obs, role, bucket }): CellUpsertOp => {
    const doc = existing.get(id);
    const inc: Record<string, number> = { games: 1, wins: obs.win ? 1 : 0 };
    const pk = serializeItemPath(obs.itemPath);

    if (!atCap(doc?.itemPaths, pk)) {
      const path = doc?.itemPaths?.[pk];
      inc[`itemPaths.${pk}.games`] = 1;
      inc[`itemPaths.${pk}.wins`] = obs.win ? 1 : 0;

      if (obs.skillOrder !== null) {
        const key = serializeSkillOrder(obs.skillOrder);
        if (!atCap(path?.skills, key)) inc[`itemPaths.${pk}.skills.${key}`] = 1;
      }
      if (obs.runePage !== null) {
        const key = serializeRunePage(obs.runePage);
        if (!atCap(path?.runes, key)) inc[`itemPaths.${pk}.runes.${key}`] = 1;
      }
      if (obs.spellPair !== null) {
        const key = serializeSpellPair(obs.spellPair);
        if (!atCap(path?.spells, key)) inc[`itemPaths.${pk}.spells.${key}`] = 1;
      }
      if (obs.startingItems !== null) {
        const key = serializeStartingItems(obs.startingItems);
        if (!atCap(path?.starts, key)) inc[`itemPaths.${pk}.starts.${key}`] = 1;
      }
    }

    return {
      updateOne: {
        filter: { _id: id },
        update: {
          $inc: inc,
          $set: {
            championKey: obs.championKey,
            role,
            rankBucket: bucket,
            region: REGION,
            patch,
            lastUpdatedAt: at,
          },
        },
        upsert: true,
      },
    };
  });

  const totalsOps = buckets.map(
    (bucket): CellUpsertOp => ({
      updateOne: {
        filter: { _id: `${bucket}|${REGION}|${patch}` },
        update: { $inc: { matches: 1 }, $set: { rankBucket: bucket, region: REGION, patch } },
        upsert: true,
      },
    }),
  );

  return { aggregateOps, totalsOps };
}

export function createAggregator(deps: { db: Db; now: () => number }): Aggregator {
  const aggregates = deps.db.collection<AggregateDoc>(CHAMPION_BUILD_AGGREGATES_COLLECTION);
  const totals = deps.db.collection<TotalsDoc>(CHAMPION_BUILD_TOTALS_COLLECTION);
  const processed = deps.db.collection<ProcessedDoc>(CRAWL_PROCESSED_COLLECTION);

  return {
    async fold(observations, matchId, seedTier) {
      if (observations.length === 0) {
        return;
      }
      if ((await processed.findOne({ _id: matchId })) !== null) {
        return;
      }

      const patch = observations[0].patch;
      const at = new Date(deps.now());

      const cellIds = [
        ...new Set(
          observations.flatMap((obs) => {
            const roles = RANKED_ROLES.has(obs.role) ? [obs.role, 'ALL'] : ['ALL'];
            return roles.flatMap((role) =>
              bucketsForTier(seedTier).map((bucket) => cellId(obs.championKey, role, bucket, patch)),
            );
          }),
        ),
      ];
      const existing = new Map<string, AggregateDoc>();
      for (const doc of await aggregates.find({ _id: { $in: cellIds } }).toArray()) {
        existing.set(doc._id, doc);
      }

      const { aggregateOps, totalsOps } = planAggregation(observations, seedTier, existing, at);

      if (aggregateOps.length > 0) {
        await aggregates.bulkWrite(aggregateOps, { ordered: false });
      }
      await totals.bulkWrite(totalsOps, { ordered: false });

      await processed.insertOne({ _id: matchId, processedAt: at }).catch((error: unknown) => {
        // A concurrent fold of the same match already marked it — fine.
        if (!(error instanceof Error && error.message.includes('duplicate key'))) {
          throw error;
        }
      });
    },
  };
}
