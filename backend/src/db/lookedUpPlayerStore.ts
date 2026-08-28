/**
 * Looked-Up Player Store.
 *
 * This site's memory of players it has successfully produced a report for. It
 * exists because Riot has no name-search endpoint: the `autofill-search` feature
 * can only suggest accounts this site has already seen, and this is where "seen"
 * is recorded.
 *
 * Pure-ish module, matching `cache/index.ts`: no network, no environment access,
 * no logging. The in-memory implementation resolves immediately but keeps the
 * Promise-returning signatures so `MongoLookedUpPlayerStore` (spec task 2.3)
 * drops in without any caller changing.
 *
 * Implements (specs/database/ requirements):
 *  - 3.1/3.3: `remember` is an upsert keyed by PUUID. A player who is looked up
 *    again has their mutable fields refreshed (a rename, a new icon) — the record
 *    is never forked.
 *  - 3.5: `searchByNamePrefix` does a case-insensitive, start-anchored `gameName`
 *    prefix match, most-recently-looked-up first, capped at `limit`. Consumed by
 *    specs/autofill-search/; this spec adds no endpoint for it.
 *  - 5.1: `deleteByPuuid` removes a PUUID's record (privacy deletion).
 */

import type { Collection, Db } from 'mongodb';
import { LOOKED_UP_PLAYERS_COLLECTION } from './collections';

/** specs/database/ Requirement 3.2. Timestamps are epoch ms from an injected clock. */
export interface LookedUpPlayer {
  puuid: string;
  gameName: string;
  tagLine: string;
  /** Nullable, mirroring `ProfileReport.profileIconId`. */
  profileIconId: number | null;
  /** Resolved platform routing value, e.g. `euw1`. */
  region: string;
  lastLookedUpAt: number;
}

export interface LookedUpPlayerStore {
  /**
   * Requirement 3.1-3.3. Upsert keyed by `player.puuid`: creates the record, or
   * replaces `gameName`, `tagLine`, `profileIconId`, `region`, and
   * `lastLookedUpAt` on an existing one. Never forks.
   */
  remember(player: LookedUpPlayer): Promise<void>;

  /**
   * Requirement 3.5. Players whose `gameName` (lowercased) starts with
   * `namePrefix` (lowercased), ordered by `lastLookedUpAt` descending, at most
   * `limit`. `namePrefix` is treated as a literal string. Empty when nothing
   * matches, `limit` is non-positive, the prefix is blank, or the store is
   * disabled.
   */
  searchByNamePrefix(namePrefix: string, limit: number): Promise<LookedUpPlayer[]>;

  /**
   * specs/autofill-search/ Requirement 9.2. The player whose `gameName` and
   * `tagLine` both match (case-insensitive, exact), or `null` when none is known
   * or the store is disabled. No Riot call — this is how the cached-report
   * endpoint resolves a name to a PUUID without touching Account-V1.
   */
  findByRiotId(gameName: string, tagLine: string): Promise<LookedUpPlayer | null>;

  /** Requirement 5.1. Removes `puuid`'s record; resolves 1 if one existed, else 0. */
  deleteByPuuid(puuid: string): Promise<number>;
}

export interface InMemoryLookedUpPlayerStoreOptions {
  /** Injected clock; unused today but accepted for parity with the other stores and future use. */
  now?: () => number;
}

/**
 * In-memory `LookedUpPlayerStore` for tests and for single-instance runs without
 * a database. Keyed by PUUID, so `remember` is an upsert by construction.
 *
 * The prefix match here is a plain lowercased `startsWith`, which is inherently
 * literal — `MongoLookedUpPlayerStore` gets the same literal semantics by
 * regex-escaping the prefix before building its anchored `RegExp`.
 */
export class InMemoryLookedUpPlayerStore implements LookedUpPlayerStore {
  private readonly byPuuid = new Map<string, LookedUpPlayer>();

  constructor(_options: InMemoryLookedUpPlayerStoreOptions = {}) {}

  async remember(player: LookedUpPlayer): Promise<void> {
    this.byPuuid.set(player.puuid, { ...player });
  }

  async searchByNamePrefix(namePrefix: string, limit: number): Promise<LookedUpPlayer[]> {
    const prefix = namePrefix.trim().toLowerCase();
    if (prefix === '' || limit <= 0) {
      return [];
    }
    return [...this.byPuuid.values()]
      .filter((p) => p.gameName.toLowerCase().startsWith(prefix))
      .sort((a, b) => b.lastLookedUpAt - a.lastLookedUpAt)
      .slice(0, Math.trunc(limit))
      .map((p) => ({ ...p }));
  }

  async findByRiotId(gameName: string, tagLine: string): Promise<LookedUpPlayer | null> {
    const g = gameName.trim().toLowerCase();
    const t = tagLine.trim().toLowerCase();
    if (g === '' || t === '') {
      return null;
    }
    for (const player of this.byPuuid.values()) {
      if (player.gameName.toLowerCase() === g && player.tagLine.toLowerCase() === t) {
        return { ...player };
      }
    }
    return null;
  }

  async deleteByPuuid(puuid: string): Promise<number> {
    return this.byPuuid.delete(puuid) ? 1 : 0;
  }

  /** Entry count; for tests and diagnostics only, not part of the interface. */
  get size(): number {
    return this.byPuuid.size;
  }
}

export function createInMemoryLookedUpPlayerStore(
  options: InMemoryLookedUpPlayerStoreOptions = {},
): InMemoryLookedUpPlayerStore {
  return new InMemoryLookedUpPlayerStore(options);
}

/**
 * The store when the Persistent_Store is disabled (specs/database/ Requirement
 * 1.3/1.4): every method is a silent no-op. Nothing is remembered, every search
 * is empty — so the `autofill-search` dropdown simply never appears, which is
 * also its correct cold-start behaviour.
 */
export function createNoopLookedUpPlayerStore(): LookedUpPlayerStore {
  return {
    async remember() {},
    async searchByNamePrefix() {
      return [];
    },
    async findByRiotId() {
      return null;
    },
    async deleteByPuuid() {
      return 0;
    },
  };
}

/** Escapes every regex metacharacter, so a typed prefix is matched literally. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * MongoDB-backed `LookedUpPlayerStore`.
 *
 *  - `remember` (Requirement 3.1/3.3): `updateOne({ _id: puuid }, { $set: … },
 *    { upsert: true })`. The PUUID is the document `_id`, so the upsert is keyed
 *    for free and a repeat lookup refreshes the mutable fields in place.
 *  - `searchByNamePrefix` (Requirement 3.5): an anchored `^prefix` regex over the
 *    lowercased `gameNameLower` field (no `i` flag needed — both sides are
 *    lowercased), sorted by `lastLookedUpAt` descending, served by the
 *    `gameNameLower_recency` index. The prefix is regex-escaped so metacharacters
 *    are literal (Requirement 2.3).
 *  - `deleteByPuuid` (Requirement 5.1): `deleteOne({ _id: puuid })`.
 *
 * BSON `Date` at rest, epoch ms across the interface.
 */
interface LookedUpPlayerDoc {
  _id: string;
  gameName: string;
  /** `gameName.toLowerCase()`, the field the prefix search actually matches on. */
  gameNameLower: string;
  tagLine: string;
  /** `tagLine.toLowerCase()`; only `findByRiotId` reads it (autofill-search Requirement 9.2). */
  tagLineLower: string;
  profileIconId: number | null;
  region: string;
  lastLookedUpAt: Date;
}

export class MongoLookedUpPlayerStore implements LookedUpPlayerStore {
  private readonly col: Collection<LookedUpPlayerDoc>;

  constructor(db: Db) {
    this.col = db.collection<LookedUpPlayerDoc>(LOOKED_UP_PLAYERS_COLLECTION);
  }

  async remember(player: LookedUpPlayer): Promise<void> {
    await this.col.updateOne(
      { _id: player.puuid },
      {
        $set: {
          gameName: player.gameName,
          gameNameLower: player.gameName.toLowerCase(),
          tagLine: player.tagLine,
          tagLineLower: player.tagLine.toLowerCase(),
          profileIconId: player.profileIconId,
          region: player.region,
          lastLookedUpAt: new Date(player.lastLookedUpAt),
        },
      },
      { upsert: true },
    );
  }

  async searchByNamePrefix(namePrefix: string, limit: number): Promise<LookedUpPlayer[]> {
    const prefix = namePrefix.trim().toLowerCase();
    if (prefix === '' || limit <= 0) {
      return [];
    }
    const docs = await this.col
      .find({ gameNameLower: { $regex: `^${escapeRegExp(prefix)}` } })
      .sort({ lastLookedUpAt: -1 })
      .limit(Math.trunc(limit))
      .toArray();
    return docs.map(toLookedUpPlayer);
  }

  async findByRiotId(gameName: string, tagLine: string): Promise<LookedUpPlayer | null> {
    const gameNameLower = gameName.trim().toLowerCase();
    const tagLineLower = tagLine.trim().toLowerCase();
    if (gameNameLower === '' || tagLineLower === '') {
      return null;
    }
    const doc = await this.col.findOne({ gameNameLower, tagLineLower });
    return doc === null ? null : toLookedUpPlayer(doc);
  }

  async deleteByPuuid(puuid: string): Promise<number> {
    const result = await this.col.deleteOne({ _id: puuid });
    return result.deletedCount ?? 0;
  }
}

function toLookedUpPlayer(doc: LookedUpPlayerDoc): LookedUpPlayer {
  return {
    puuid: doc._id,
    gameName: doc.gameName,
    tagLine: doc.tagLine,
    profileIconId: doc.profileIconId,
    region: doc.region,
    lastLookedUpAt: doc.lastLookedUpAt.getTime(),
  };
}
