/**
 * Persistent Store connection.
 *
 * The one place a `MongoClient` is created for the process, mirroring how
 * `index.ts` already builds exactly one clock, one `CacheStore`, and one
 * `RateLimitManager`. Every store implementation shares this connection.
 *
 * Implements (specs/database/ requirements):
 *  - 1.2: the connection string is read from `MONGODB_URI` and nowhere else
 *    (the caller passes it in; this module never touches `process.env`).
 *  - 1.3: an unset URI yields a disabled handle — the site runs exactly as it
 *    did before this feature, with the no-op stores.
 *  - 1.4: a set-but-unreachable URI logs once (credentials stripped) and also
 *    yields a disabled handle rather than crashing the process.
 *  - 1.5: TLS + SCRAM come from the Atlas SRV string; the pool is capped well
 *    below the M0 500-connection ceiling.
 *  - 1.6: `close()` shuts the client down.
 *  - 1.7: every index the stores rely on is created at startup, idempotently.
 *
 * This module does NOT depend on the store modules, so importing the collection
 * name constants from here into `rankHistoryStore.ts` / `lookedUpPlayerStore.ts`
 * introduces no cycle.
 */

import { MongoClient, type Db } from 'mongodb';
import {
  DATABASE_NAME,
  LOOKED_UP_PLAYERS_COLLECTION,
  PROFILE_REPORT_TTL_SECONDS,
  PROFILE_REPORTS_COLLECTION,
  RANK_SNAPSHOTS_COLLECTION,
} from './collections';

export { DATABASE_NAME, RANK_SNAPSHOTS_COLLECTION, LOOKED_UP_PLAYERS_COLLECTION, PROFILE_REPORTS_COLLECTION };

/** Low tens — one instance needs a handful of sockets; the M0 ceiling is 500. */
const MAX_POOL_SIZE = 20;
/** Fail a bad URI at startup in seconds, rather than letting `connect()` hang. */
const SERVER_SELECTION_TIMEOUT_MS = 8_000;

export interface DatabaseClient {
  /** `true` once connected; `false` for an unset URI or a failed startup connection. */
  readonly enabled: boolean;
  /** The connected database. Throws when `enabled` is `false` — callers build the no-op stores instead. */
  db(): Db;
  /** Closes the underlying client. Safe to call on a disabled handle (no-op). */
  close(): Promise<void>;
}

export interface DatabaseClientLogger {
  connectionFailed(info: { reason: string }): void;
}

export const consoleDatabaseClientLogger: DatabaseClientLogger = {
  connectionFailed({ reason }) {
    // eslint-disable-next-line no-console
    console.error(
      `[lolprofiles] MONGODB_URI is set but the database could not be reached: ${reason}. ` +
        `Continuing with the persistent store disabled — rank history and player autocomplete will be unavailable.`,
    );
  },
};

const DISABLED_HANDLE: DatabaseClient = {
  enabled: false,
  db() {
    throw new Error('DatabaseClient is disabled; check `enabled` before calling `db()`.');
  },
  async close() {},
};

/**
 * Replaces any `user:password@` credential segment in a Mongo connection string
 * with `***@`, so a connection-failure log can quote the reason without leaking
 * the password. Applied to the driver's error message too, since it sometimes
 * echoes the URI back.
 */
export function redactMongoUri(text: string): string {
  return text.replace(/\/\/[^/@\s]+@/g, '//***@');
}

/**
 * Provisions every index the stores rely on. Idempotent — safe to run on each
 * startup. Exported so an integration test can provision a throwaway database.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  await db.collection(RANK_SNAPSHOTS_COLLECTION).createIndexes([
    // Requirement 6.2: the database, not application code, guarantees one
    // snapshot per player per queue per UTC day.
    { key: { puuid: 1, queueType: 1, snapshotDay: 1 }, unique: true, name: 'uniq_puuid_queue_day' },
    // Serves `history()` in sorted order and the `deleteByPuuid` sweep.
    { key: { puuid: 1, queueType: 1, observedAt: 1 }, name: 'puuid_queue_observedAt' },
  ]);
  await db
    .collection(LOOKED_UP_PLAYERS_COLLECTION)
    // Serves the anchored `gameNameLower` prefix scan, already ordered by recency.
    // The `gameNameLower` equality also narrows `findByRiotId`'s `tagLineLower` match.
    .createIndexes([{ key: { gameNameLower: 1, lastLookedUpAt: -1 }, name: 'gameNameLower_recency' }]);
  await db.collection(PROFILE_REPORTS_COLLECTION).createIndexes([
    // specs/autofill-search/ Requirement 8.8: the database reclaims abandoned
    // snapshots. 15 days === Snapshot_Max_Age, so a snapshot the endpoint would
    // reject as stale is usually already gone; the endpoint still checks age
    // (9.4) because the TTL monitor only runs about once a minute.
    { key: { fetchedAt: 1 }, name: 'ttl_fetchedAt', expireAfterSeconds: PROFILE_REPORT_TTL_SECONDS },
  ]);
}

export interface CreateDatabaseClientOptions {
  /** The value of `MONGODB_URI`, or `undefined` when it is unset. */
  uri: string | undefined;
  logger?: DatabaseClientLogger;
}

/**
 * Connects to MongoDB and provisions indexes, or returns a disabled handle.
 *
 * Never throws: an unset URI (Requirement 1.3) and an unreachable one
 * (Requirement 1.4) both resolve to `DISABLED_HANDLE`, the latter after a single
 * credential-stripped log line.
 */
export async function createDatabaseClient(
  options: CreateDatabaseClientOptions,
): Promise<DatabaseClient> {
  const uri = options.uri?.trim();
  if (uri === undefined || uri === '') {
    return DISABLED_HANDLE;
  }

  const logger = options.logger ?? consoleDatabaseClientLogger;
  let client: MongoClient | undefined;

  try {
    // Constructing the client can itself throw on a malformed URI, so it is
    // inside the try — Requirement 1.4's "SHALL NOT crash" covers this case too.
    client = new MongoClient(uri, {
      maxPoolSize: MAX_POOL_SIZE,
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
    });
    await client.connect();
    const db = client.db(DATABASE_NAME);
    await ensureIndexes(db);

    const connected = client;
    return {
      enabled: true,
      db: () => db,
      close: () => connected.close(),
    };
  } catch (err) {
    logger.connectionFailed({
      reason: redactMongoUri(err instanceof Error ? err.message : String(err)),
    });
    await client?.close().catch(() => {});
    return DISABLED_HANDLE;
  }
}
