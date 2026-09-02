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
 * most one snapshot per queue per few games, by design, so the graph's spacing
 * stays clean — but that means it almost never brackets an individual match
 * tightly enough. This store is a SEPARATE collection, recorded on every fresh
 * lookup for every ranked queue the player has an entry in — solo/duo, flex,
 * and any other ranked queue Riot reports (e.g. a legacy 5v5 premade queue, if a
 * report ever carries one; today's Match-V5 queue-id table has no id that
 * produces a match `queueType` for it, so `insight/lpDelta.ts` can only ever
 * attribute a delta to solo/duo and flex matches — see that module's own note).
 *
 * A checkpoint is DROPPED when it reports the same total game count
 * (`wins + losses`) as the last one kept for its queue: a lookup that lands
 * between two ranked games carries no new bracketing information, and keeping it
 * would only create 0-game windows for `insight/lpDelta.ts` to reason around.
 * Every adjacent checkpoint pair therefore brackets at least one real game
 * (2026-09-02). Falls back to keeping the checkpoint when either side lacks the
 * game counts (data written before that field existed).
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
  /**
   * League-V4 cumulative `wins` / `losses` for this queue at observation time.
   * Two checkpoints' difference gives the exact number — and win/loss split — of
   * ranked games played in the interval, which is what lets `insight/lpDelta.ts`
   * tell a complete bracket from one with games it cannot see, and a real game
   * from LP decay. Optional so checkpoints written before this field existed
   * still load (they read back `undefined`, and the delta logic falls back).
   */
  wins?: number;
  losses?: number;
  observedAt: number;
}

export interface RankCheckpointStore {
  /**
   * Inserts `checkpoint` unless the last one kept for its `(puuid, queueType)`
   * reports the same total game count (`wins + losses`) — see `shouldRecordCheckpoint`.
   * Never dedups by day or value, unlike `RankHistoryStore.record`.
   */
  record(checkpoint: RankCheckpoint): Promise<void>;
  /** Every checkpoint for `puuid`, across every queue, oldest first. Empty when there are none or the store is disabled. */
  historyAll(puuid: string): Promise<RankCheckpoint[]>;
  /** Removes every checkpoint for `puuid`; resolves the count removed. */
  deleteByPuuid(puuid: string): Promise<number>;
}

/** `wins + losses` for a checkpoint, or `undefined` when it carries neither. */
export function checkpointGamesPlayed(checkpoint: RankCheckpoint): number | undefined {
  return checkpoint.wins === undefined || checkpoint.losses === undefined
    ? undefined
    : checkpoint.wins + checkpoint.losses;
}

/**
 * Whether `next` is worth keeping given `previous`, the most recent checkpoint
 * already kept for the same `(puuid, queueType)`. Keep when there is no prior
 * one, when either side lacks game counts (cannot compare), or when the total
 * game count moved. Drop only the exact "same games, just a later lookup" case.
 */
export function shouldRecordCheckpoint(
  previous: RankCheckpoint | undefined,
  next: RankCheckpoint,
): boolean {
  if (previous === undefined) {
    return true;
  }
  const before = checkpointGamesPlayed(previous);
  const after = checkpointGamesPlayed(next);
  if (before === undefined || after === undefined) {
    return true;
  }
  return before !== after;
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
    let latest: RankCheckpoint | undefined;
    for (const c of this.checkpoints) {
      if (
        c.puuid === checkpoint.puuid &&
        c.queueType === checkpoint.queueType &&
        (latest === undefined || c.observedAt > latest.observedAt)
      ) {
        latest = c;
      }
    }
    if (shouldRecordCheckpoint(latest, checkpoint)) {
      this.checkpoints.push({ ...checkpoint });
    }
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
 *  - `record`: read the latest checkpoint for `(puuid, queueType)` down the
 *    `puuid_observedAt` index, then `insertOne` only when `shouldRecordCheckpoint`
 *    agrees (the game count moved, or there is nothing to compare against). No
 *    unique index — the rule is a game-count comparison, not a key.
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
  wins?: number;
  losses?: number;
  observedAt: Date;
}

function docToCheckpoint(d: RankCheckpointDoc): RankCheckpoint {
  return {
    puuid: d.puuid,
    queueType: d.queueType,
    tier: d.tier,
    division: d.division,
    leaguePoints: d.leaguePoints,
    ...(d.wins !== undefined ? { wins: d.wins } : {}),
    ...(d.losses !== undefined ? { losses: d.losses } : {}),
    observedAt: d.observedAt.getTime(),
  };
}

export class MongoRankCheckpointStore implements RankCheckpointStore {
  private readonly col: Collection<RankCheckpointDoc>;

  constructor(db: Db) {
    this.col = db.collection<RankCheckpointDoc>(RANK_CHECKPOINTS_COLLECTION);
  }

  async record(checkpoint: RankCheckpoint): Promise<void> {
    const latest = await this.col.findOne(
      { puuid: checkpoint.puuid, queueType: checkpoint.queueType },
      { sort: { observedAt: -1 } },
    );
    if (!shouldRecordCheckpoint(latest === null ? undefined : docToCheckpoint(latest), checkpoint)) {
      return;
    }
    const doc: RankCheckpointDoc = {
      puuid: checkpoint.puuid,
      queueType: checkpoint.queueType,
      tier: checkpoint.tier,
      division: checkpoint.division,
      leaguePoints: checkpoint.leaguePoints,
      observedAt: new Date(checkpoint.observedAt),
    };
    if (checkpoint.wins !== undefined) {
      doc.wins = checkpoint.wins;
    }
    if (checkpoint.losses !== undefined) {
      doc.losses = checkpoint.losses;
    }
    await this.col.insertOne(doc);
  }

  async historyAll(puuid: string): Promise<RankCheckpoint[]> {
    const docs = await this.col.find({ puuid }).sort({ observedAt: 1 }).toArray();
    return docs.map(docToCheckpoint);
  }

  async deleteByPuuid(puuid: string): Promise<number> {
    const result = await this.col.deleteMany({ puuid });
    return result.deletedCount ?? 0;
  }
}
