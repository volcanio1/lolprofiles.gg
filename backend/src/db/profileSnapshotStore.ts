/**
 * Profile Snapshot Store.
 *
 * The persistence layer for specs/autofill-search/ Requirements 8-10: the most
 * recent full `ProfileReport` for a player, so that picking that player from the
 * autocomplete dropdown renders instantly from storage instead of waiting on a
 * live lookup. One document per player, keyed by PUUID, newest replacing any
 * prior one.
 *
 * Architecturally this belongs to the same storage layer as `rankHistoryStore`
 * and `lookedUpPlayerStore` (an extension of `specs/database/`); it is built here
 * because a Report_Snapshot is only ever consumed by a Suggestion_Selection.
 *
 * Pure-ish module, matching the other stores: no network, no environment access,
 * no logging. The in-memory implementation resolves immediately but keeps the
 * Promise-returning signatures so `MongoProfileSnapshotStore` drops in without
 * any caller changing.
 *
 * The `ProfileReport` type is imported type-only from the orchestrator, so no
 * runtime import cycle is introduced (the orchestrator imports the *value*
 * `createNoopProfileSnapshotStore` from here; this file imports nothing from
 * there that survives compilation).
 *
 * Implements:
 *  - 8.2: `save` is an upsert keyed by PUUID.
 *  - 8.3: the stored value is the `ProfileReport` verbatim plus `fetchedAt` (epoch ms).
 *  - 9.3: `get` returns the stored snapshot and its age; judging staleness is the
 *    caller's job (the endpoint checks it against `Snapshot_Max_Age`).
 *  - 8.7: `deleteByPuuid` removes a PUUID's snapshot (privacy deletion).
 */

import type { Collection, Db } from 'mongodb';
import type { ProfileReport } from '../orchestrator';
import { PROFILE_REPORTS_COLLECTION } from './collections';

/** specs/autofill-search/ Requirement 9.3. */
export interface StoredReport {
  report: ProfileReport;
  /** Epoch ms when the lookup that produced this report completed. */
  fetchedAt: number;
}

export interface ProfileSnapshotStore {
  /** Requirement 8.1/8.2. Upsert keyed by `puuid`; the newest report wins. */
  save(puuid: string, report: ProfileReport, fetchedAt: number): Promise<void>;

  /** Requirement 9.3. The stored snapshot for `puuid`, or `null` when there is none. */
  get(puuid: string): Promise<StoredReport | null>;

  /** Requirement 8.7. Removes `puuid`'s snapshot; resolves 1 if one existed, else 0. */
  deleteByPuuid(puuid: string): Promise<number>;
}

/**
 * In-memory `ProfileSnapshotStore` for tests and for single-instance runs
 * without a database. Keyed by PUUID, so `save` is an upsert by construction.
 * Stored reports are shallow-cloned at the `StoredReport` boundary on the way in
 * and out; the `report` object graph itself is shared, which is fine because a
 * `ProfileReport` is only ever read.
 */
export class InMemoryProfileSnapshotStore implements ProfileSnapshotStore {
  private readonly byPuuid = new Map<string, StoredReport>();

  async save(puuid: string, report: ProfileReport, fetchedAt: number): Promise<void> {
    this.byPuuid.set(puuid, { report, fetchedAt });
  }

  async get(puuid: string): Promise<StoredReport | null> {
    const stored = this.byPuuid.get(puuid);
    return stored === undefined ? null : { report: stored.report, fetchedAt: stored.fetchedAt };
  }

  async deleteByPuuid(puuid: string): Promise<number> {
    return this.byPuuid.delete(puuid) ? 1 : 0;
  }

  /** Entry count; for tests and diagnostics only, not part of the interface. */
  get size(): number {
    return this.byPuuid.size;
  }
}

export function createInMemoryProfileSnapshotStore(): InMemoryProfileSnapshotStore {
  return new InMemoryProfileSnapshotStore();
}

/**
 * The store when the Persistent_Store is disabled (specs/database/ Requirement
 * 1.3/1.4): every method is a silent no-op. `save` writes nothing, `get` is
 * `null` — so a Suggestion_Selection always falls through to a live lookup,
 * which is also the correct cold-start behaviour.
 */
export function createNoopProfileSnapshotStore(): ProfileSnapshotStore {
  return {
    async save() {},
    async get() {
      return null;
    },
    async deleteByPuuid() {
      return 0;
    },
  };
}

/**
 * MongoDB-backed `ProfileSnapshotStore`.
 *
 *  - `save` (Requirement 8.2): `updateOne({ _id: puuid }, { $set: … }, { upsert: true })`.
 *    The PUUID is the document `_id`, so the upsert is keyed for free.
 *  - `get` (Requirement 9.3): `findOne({ _id: puuid })`.
 *  - `deleteByPuuid` (Requirement 8.7): `deleteOne({ _id: puuid })`.
 *
 * `fetchedAt` is a BSON `Date` at rest (so the `ttl_fetchedAt` index can expire
 * on it) and epoch ms across the interface.
 */
interface ProfileReportDoc {
  _id: string;
  report: ProfileReport;
  fetchedAt: Date;
}

export class MongoProfileSnapshotStore implements ProfileSnapshotStore {
  private readonly col: Collection<ProfileReportDoc>;

  constructor(db: Db) {
    this.col = db.collection<ProfileReportDoc>(PROFILE_REPORTS_COLLECTION);
  }

  async save(puuid: string, report: ProfileReport, fetchedAt: number): Promise<void> {
    await this.col.updateOne(
      { _id: puuid },
      { $set: { report, fetchedAt: new Date(fetchedAt) } },
      { upsert: true },
    );
  }

  async get(puuid: string): Promise<StoredReport | null> {
    const doc = await this.col.findOne({ _id: puuid });
    return doc === null ? null : { report: doc.report, fetchedAt: doc.fetchedAt.getTime() };
  }

  async deleteByPuuid(puuid: string): Promise<number> {
    const result = await this.col.deleteOne({ _id: puuid });
    return result.deletedCount ?? 0;
  }
}
