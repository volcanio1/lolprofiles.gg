/**
 * Match Store.
 *
 * specs/match-cache/: a persistent, restart-surviving tier for match details,
 * layered under the in-memory `matchDetail` cache. A completed match never
 * changes, so once fetched it is stored forever (bounded only by a TTL index for
 * M0 storage, never for correctness), and one stored match — keyed by `matchId`
 * alone — serves every player who was in that game, because
 * `orchestrator/mapping.ts`'s `toIncludedMatch(match, puuid)` derives every
 * perspective-relative fact at read time.
 *
 * Same shape as the sibling stores (`rankHistoryStore`, `lookedUpPlayerStore`,
 * `profileSnapshotStore`): a pure interface, an in-memory fake, a no-op for the
 * disabled state, and a Mongo implementation.
 *
 * The `MatchDto` type is imported type-only from `../riotApiClient`, so no
 * runtime import cycle is created.
 *
 * ---------------------------------------------------------------------------
 * WHY `getMany` IS INTERNALLY BOUNDED
 * ---------------------------------------------------------------------------
 *
 * `getMany` is the one store read this codebase puts on the request's critical
 * path (specs/match-cache/ Requirement 3): the orchestrator consults it before
 * deciding whether to call Riot. It must therefore never make a lookup slower
 * than it is today. `MongoMatchStore.getMany` caps server-side work with
 * `maxTimeMS` AND races the whole call against an injected timeout — a slow,
 * unreachable, or hung store resolves to "nothing stored", and the lookup falls
 * through to Riot exactly as it does now. It never rejects.
 */

import type { Collection, Db } from 'mongodb';
import type { MatchDto } from '../riotApiClient';
import type { TimeoutScheduler } from '../riotApiClient';
import { MATCH_DETAILS_COLLECTION } from './collections';

export interface StoredMatch {
  matchId: string;
  /** The trimmed `MatchDto` shape (`riotApiClient/matchProjection.ts`), ~5 KB. */
  match: MatchDto;
  /** The RegionalRoutingValue it was fetched from. Diagnostic; not load-bearing. */
  region: string;
  /** Epoch ms it was stored. */
  storedAt: number;
}

export interface MatchStore {
  /**
   * Requirement 3.1. The Stored_Matches for `matchIds` that exist, as a Map
   * keyed by `matchId`. Requirement 3.4: never rejects — a failure or a timeout
   * yields an empty Map.
   */
  getMany(matchIds: readonly string[]): Promise<Map<string, StoredMatch>>;

  /** Requirement 4.1/4.2. Upsert each Stored_Match by `matchId`. */
  putMany(matches: readonly StoredMatch[]): Promise<void>;

  /** Requirement 6.1. Delete every Stored_Match `puuid` participated in; resolves the count. */
  deleteByPuuid(puuid: string): Promise<number>;
}

/**
 * In-memory `MatchStore` for tests and single-instance runs without a database.
 * Keyed by `matchId`, so `putMany` is an upsert by construction.
 */
export class InMemoryMatchStore implements MatchStore {
  private readonly byId = new Map<string, StoredMatch>();

  async getMany(matchIds: readonly string[]): Promise<Map<string, StoredMatch>> {
    const result = new Map<string, StoredMatch>();
    for (const matchId of matchIds) {
      const stored = this.byId.get(matchId);
      if (stored !== undefined) {
        result.set(matchId, { ...stored });
      }
    }
    return result;
  }

  async putMany(matches: readonly StoredMatch[]): Promise<void> {
    for (const match of matches) {
      this.byId.set(match.matchId, { ...match });
    }
  }

  async deleteByPuuid(puuid: string): Promise<number> {
    let removed = 0;
    for (const [matchId, stored] of [...this.byId]) {
      if (stored.match.metadata.participants.includes(puuid)) {
        this.byId.delete(matchId);
        removed += 1;
      }
    }
    return removed;
  }

  /** Entry count; tests and diagnostics only. */
  get size(): number {
    return this.byId.size;
  }
}

export function createInMemoryMatchStore(): InMemoryMatchStore {
  return new InMemoryMatchStore();
}

/**
 * The store when the Persistent_Store is disabled (Requirement 1.4): every
 * method is a silent no-op. `getMany` is always empty, so every match id is a
 * "miss" and the fan-out fetches from Riot exactly as today.
 */
export function createNoopMatchStore(): MatchStore {
  return {
    async getMany() {
      return new Map();
    },
    async putMany() {},
    async deleteByPuuid() {
      return 0;
    },
  };
}

/** Requirement 3.4 — the internal deadline for the critical-path read. */
export const MATCH_STORE_READ_TIMEOUT_MS = 1_500;

interface MatchDetailDoc {
  _id: string;
  match: MatchDto;
  region: string;
  storedAt: Date;
}

const defaultTimeoutScheduler: TimeoutScheduler = (ms, onElapsed) => {
  const handle = setTimeout(onElapsed, ms);
  return () => {
    clearTimeout(handle);
  };
};

export interface MongoMatchStoreOptions {
  /** Injected so a test never waits on the real deadline. */
  scheduleTimeout?: TimeoutScheduler;
  readTimeoutMs?: number;
}

/**
 * MongoDB-backed `MatchStore`. `_id` is the `matchId`.
 *
 *  - `getMany` (Requirement 3.1/3.4): `find({ _id: { $in } })` with `maxTimeMS`,
 *    raced against an injected timeout; either failure path resolves to an empty
 *    Map, never a rejection.
 *  - `putMany` (Requirement 4.1/4.2/4.5): one `bulkWrite` of upserts.
 *  - `deleteByPuuid` (Requirement 6.1/6.2): `deleteMany` over the multikey
 *    `match.metadata.participants` index — eviction, not redaction.
 *
 * `storedAt` is a BSON `Date` at rest (so the `ttl_storedAt` index expires on
 * it), epoch ms across the interface.
 */
export class MongoMatchStore implements MatchStore {
  private readonly col: Collection<MatchDetailDoc>;
  private readonly scheduleTimeout: TimeoutScheduler;
  private readonly readTimeoutMs: number;

  constructor(db: Db, options: MongoMatchStoreOptions = {}) {
    this.col = db.collection<MatchDetailDoc>(MATCH_DETAILS_COLLECTION);
    this.scheduleTimeout = options.scheduleTimeout ?? defaultTimeoutScheduler;
    this.readTimeoutMs = options.readTimeoutMs ?? MATCH_STORE_READ_TIMEOUT_MS;
  }

  async getMany(matchIds: readonly string[]): Promise<Map<string, StoredMatch>> {
    if (matchIds.length === 0) {
      return new Map();
    }

    const query = this.col
      .find({ _id: { $in: [...matchIds] } })
      .maxTimeMS(this.readTimeoutMs)
      .toArray();

    let cancelDeadline: () => void = () => {};
    const deadline = new Promise<null>((resolve) => {
      cancelDeadline = this.scheduleTimeout(this.readTimeoutMs, () => resolve(null));
    });

    let docs: MatchDetailDoc[] | null;
    try {
      docs = await Promise.race([query, deadline]);
    } catch {
      // Requirement 3.4: a store failure is indistinguishable from an empty store.
      docs = null;
    } finally {
      cancelDeadline();
    }

    const result = new Map<string, StoredMatch>();
    if (docs === null) {
      return result;
    }
    for (const doc of docs) {
      result.set(doc._id, {
        matchId: doc._id,
        match: doc.match,
        region: doc.region,
        storedAt: doc.storedAt.getTime(),
      });
    }
    return result;
  }

  async putMany(matches: readonly StoredMatch[]): Promise<void> {
    if (matches.length === 0) {
      return;
    }
    await this.col.bulkWrite(
      matches.map((entry) => ({
        updateOne: {
          filter: { _id: entry.matchId },
          update: { $set: { match: entry.match, region: entry.region, storedAt: new Date(entry.storedAt) } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  async deleteByPuuid(puuid: string): Promise<number> {
    const result = await this.col.deleteMany({ 'match.metadata.participants': puuid });
    return result.deletedCount ?? 0;
  }
}
