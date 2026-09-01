/**
 * Rank Checkpoint Store.
 *
 * recent-matches-lp-delta: the persistence layer behind "show LP gained/lost
 * next to a ranked match in Recent Matches" (user request, 2026-09-01).
 *
 * Riot's Match-V5 response carries no LP field at all — only League-V4 (the
 * player's CURRENT cumulative standing) does. The only way to attribute an LP
 * delta to one specific match is to have two League-V4 readings that bracket
 * it in time, with exactly that one ranked match of that queue between them.
 * `rank_snapshots` (`rankHistoryStore.ts`) cannot serve this: it records at
 * most one snapshot per queue per UTC calendar day, by design, so the graph's
 * spacing stays clean — but that means it almost never brackets an individual
 * match tightly enough. This store is a SEPARATE collection, recorded on
 * EVERY fresh lookup (no dedup at all), for every ranked queue the player has
 * an entry in — solo/duo, flex, and any other ranked queue Riot reports
 * (e.g. a legacy 5v5 premade queue, if a report ever carries one; today's
 * Match-V5 queue-id table has no id that produces a match `queueType` for it,
 * so `insight/lpDelta.ts` can only ever attribute a delta to solo/duo and flex
 * matches — see that module's own note).
 *
 * Because checkpoints only start accumulating from the day this ships, and
 * because a delta is knowable only when two checkpoints bracket a match with
 * NO other same-queue ranked match also falling in that same window, most
 * matches — especially anything older than this feature — will simply have
 * no LP delta available. That is the correct, honest outcome for data Riot
 * never exposes, not a bug to paper over.
 *
 * Pure-ish module, matching `rankHistoryStore.ts`: no network, no environment
 * access, no logging.
 */

import type { Collection, Db } from 'mongodb';
import { RANK_CHECKPOINTS_COLLECTION } from './collections';

export interface RankCheckpoint {
  puuid: string;
  /** Raw League-V4 queue type string, e.g. `RANKED_SOLO_5x5`. */
  queueType: string;
  tier: string;
  /** `''` for apex tiers, matching `LeagueEntry.division`. */
  division: string;
  leaguePoints: number;
  observedAt: number;
}

export interface RankCheckpointStore {
  /** Always inserts — no dedup, unlike `RankHistoryStore.record`. */
  record(checkpoint: RankCheckpoint): Promise<void>;
  /** Every checkpoint for `puuid`, across every queue, oldest first. Empty when there are none or the store is disabled. */
  historyAll(puuid: string): Promise<RankCheckpoint[]>;
  /** Removes every checkpoint for `puuid`; resolves the count removed. */
  deleteByPuuid(puuid: string): Promise<number>;
}

export interface InMemoryRankCheckpointStoreOptions {
  /** Injected clock; unused today but accepted for parity with the other stores and future use. */
  now?: () => number;
}

/**
 * In-memory `RankCheckpointStore` for tests and single-instance runs without a
 * database. Stored checkpoints are copied on the way in and out, so a caller
 * holding a returned array never sees the store's state change underneath it.
 */
export class InMemoryRankCheckpointStore implements RankCheckpointStore {
  private readonly checkpoints: RankCheckpoint[] = [];

  constructor(_options: InMemoryRankCheckpointStoreOptions = {}) {}

  async record(checkpoint: RankCheckpoint): Promise<void> {
    this.checkpoints.push({ ...checkpoint });
  }

  async historyAll(puuid: string): Promise<RankCheckpoint[]> {
    return this.checkpoints
      .filter((c) => c.puuid === puuid)
      .sort((a, b) => a.observedAt - b.observedAt)
      .map((c) => ({ ...c }));
  }

  async deleteByPuuid(puuid: string): Promise<number> {
    let removed = 0;
    for (let i = this.checkpoints.length - 1; i >= 0; i -= 1) {
      if (this.checkpoints[i]?.puuid === puuid) {
        this.checkpoints.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }

  /** Entry count; for tests and diagnostics only, not part of the interface. */
  get size(): number {
    return this.checkpoints.length;
  }
}

export function createInMemoryRankCheckpointStore(
  options: InMemoryRankCheckpointStoreOptions = {},
): InMemoryRankCheckpointStore {
  return new InMemoryRankCheckpointStore(options);
}

/**
 * The store when the Persistent_Store is disabled: every method is a silent
 * no-op, matching `createNoopRankHistoryStore`'s contract exactly.
 */
export function createNoopRankCheckpointStore(): RankCheckpointStore {
  return {
    async record() {},
    async historyAll() {
      return [];
    },
    async deleteByPuuid() {
      return 0;
    },
  };
}

/**
 * MongoDB-backed `RankCheckpointStore`.
 *
 *  - `record`: a plain `insertOne` — no upsert, no dedup key, unlike
 *    `MongoRankHistoryStore`. Every fresh lookup writes one row per ranked
 *    queue the player has.
 *  - `historyAll`: `find({ puuid })` + `sort({ observedAt: 1 })`, served by
 *    the `puuid_observedAt` index.
 *  - `deleteByPuuid`: `deleteMany({ puuid })`.
 *
 * BSON `Date` at rest, epoch ms across the interface — mapped at this boundary.
 */
interface RankCheckpointDoc {
  puuid: string;
  queueType: string;
  tier: string;
  division: string;
  leaguePoints: number;
  observedAt: Date;
}

export class MongoRankCheckpointStore implements RankCheckpointStore {
  private readonly col: Collection<RankCheckpointDoc>;

  constructor(db: Db) {
    this.col = db.collection<RankCheckpointDoc>(RANK_CHECKPOINTS_COLLECTION);
  }

  async record(checkpoint: RankCheckpoint): Promise<void> {
    const doc: RankCheckpointDoc = {
      puuid: checkpoint.puuid,
      queueType: checkpoint.queueType,
      tier: checkpoint.tier,
      division: checkpoint.division,
      leaguePoints: checkpoint.leaguePoints,
      observedAt: new Date(checkpoint.observedAt),
    };
    await this.col.insertOne(doc);
  }

  async historyAll(puuid: string): Promise<RankCheckpoint[]> {
    const docs = await this.col.find({ puuid }).sort({ observedAt: 1 }).toArray();
    return docs.map((d) => ({
      puuid: d.puuid,
      queueType: d.queueType,
      tier: d.tier,
      division: d.division,
      leaguePoints: d.leaguePoints,
      observedAt: d.observedAt.getTime(),
    }));
  }

  async deleteByPuuid(puuid: string): Promise<number> {
    const result = await this.col.deleteMany({ puuid });
    return result.deletedCount ?? 0;
  }
}
