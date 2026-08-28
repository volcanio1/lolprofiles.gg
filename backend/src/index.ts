/**
 * Composition root.
 *
 * The only place where the concrete dependency graph is built. Every module below
 * takes its collaborators as parameters, so this file is the single spot that
 * decides what "real" means: the wall clock, the global `fetch`, the in-memory
 * cache, the API key from the environment, and — when `MONGODB_URI` is set — the
 * persistent store connection.
 *
 * ONE CLOCK FOR THE WHOLE GRAPH. The cache store stamps `retrievedAt` with it, the
 * rate limiter measures its windows with it, `cacheOrFetch` judges staleness with
 * it, and the orchestrator computes `lastUpdated` from it. Handing different clocks
 * to different modules would make those timestamps incomparable, so `now` is
 * created once here and passed everywhere.
 *
 * ONE RATE LIMIT MANAGER FOR THE WHOLE PROCESS. Riot enforces its limits per API
 * key per routing value, not per request or per user, so the pre-flight
 * reservation only means anything if every outgoing call shares one instance
 * (Requirement 4.3).
 *
 * ONE DATABASE CLIENT FOR THE WHOLE PROCESS (specs/database/ Requirement 1.1).
 * Built once here; when `MONGODB_URI` is unset or unreachable it is a disabled
 * handle and the no-op stores are used, so the site runs exactly as it did
 * before the persistent store existed.
 */

import { isAbsolute, resolve } from 'node:path';
import 'dotenv/config';
import { loadConfig } from './config';
import { createApp } from './app';
import { createInMemoryCacheStore } from './cache';
import { createDatabaseClient } from './db/client';
import {
  createNoopRankHistoryStore,
  MongoRankHistoryStore,
  type RankHistoryStore,
} from './db/rankHistoryStore';
import {
  createNoopLookedUpPlayerStore,
  MongoLookedUpPlayerStore,
  type LookedUpPlayerStore,
} from './db/lookedUpPlayerStore';
import {
  createNoopProfileSnapshotStore,
  MongoProfileSnapshotStore,
  type ProfileSnapshotStore,
} from './db/profileSnapshotStore';
import { createNoopMatchStore, MongoMatchStore, type MatchStore } from './db/matchStore';
import { createLookupOrchestrator } from './orchestrator';
import { createBuildPathOrchestrator } from './orchestrator/buildPath';
import { createLiveGameOrchestrator } from './liveGame/orchestrator';
import { createRateLimitManager } from './rateLimit';
import { createRiotApiClient, type RiotHttpTransport } from './riotApiClient';

async function main(): Promise<void> {
  // Load config first so misconfiguration fails fast, before the app starts.
  // This is also the only read of the API key; it is passed to the Riot API
  // Client and never travels anywhere else.
  const config = loadConfig();

  const now = () => Date.now();

  const cache = createInMemoryCacheStore({ now });
  const rateLimitManager = createRateLimitManager({ now });

  // specs/database/ Requirements 1.3/1.4: never throws — an unset or unreachable
  // URI yields a disabled handle, and the no-op stores below.
  const databaseClient = await createDatabaseClient({ uri: config.mongodbUri });
  const rankHistoryStore: RankHistoryStore = databaseClient.enabled
    ? new MongoRankHistoryStore(databaseClient.db())
    : createNoopRankHistoryStore();
  const lookedUpPlayerStore: LookedUpPlayerStore = databaseClient.enabled
    ? new MongoLookedUpPlayerStore(databaseClient.db())
    : createNoopLookedUpPlayerStore();
  const profileSnapshotStore: ProfileSnapshotStore = databaseClient.enabled
    ? new MongoProfileSnapshotStore(databaseClient.db())
    : createNoopProfileSnapshotStore();
  const matchStore: MatchStore = databaseClient.enabled
    ? new MongoMatchStore(databaseClient.db())
    : createNoopMatchStore();

  if (databaseClient.enabled) {
    // eslint-disable-next-line no-console
    console.log('[lolprofiles] Persistent store connected (rank history + player autocomplete).');
  }

  /** The real HTTP transport. A `Response` structurally satisfies `RiotHttpResponse`. */
  const transport: RiotHttpTransport = (url, init) => fetch(url, init);

  const riotApiClient = createRiotApiClient({
    fetch: transport,
    apiKey: config.riotApiKey,
    rateLimitManager,
    now,
  });

  const orchestrator = createLookupOrchestrator({
    cache,
    riotApiClient,
    now,
    matchHistoryCount: config.matchHistoryCount,
    rankHistoryStore,
    lookedUpPlayerStore,
    profileSnapshotStore,
    matchStore,
  });

  const buildPathOrchestrator = createBuildPathOrchestrator({ cache, riotApiClient, now });

  const liveGameOrchestrator = createLiveGameOrchestrator({ client: riotApiClient, cache, now });

  const staticDir =
    config.frontendDistPath === undefined
      ? undefined
      : isAbsolute(config.frontendDistPath)
        ? config.frontendDistPath
        : resolve(process.cwd(), config.frontendDistPath);

  const app = createApp({
    orchestrator,
    buildPathOrchestrator,
    liveGameOrchestrator,
    cache,
    now,
    allowedOrigins: config.allowedOrigins,
    dataDragonVersion: config.dataDragonVersion,
    staticDir,
    rankHistoryStore,
    lookedUpPlayerStore,
    profileSnapshotStore,
    matchStore,
  });

  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Backend listening on port ${config.port}`);
  });

  // specs/database/ Requirement 1.6: close the client on shutdown.
  const shutdown = () => {
    server.close(() => {
      void databaseClient.close().finally(() => process.exit(0));
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[lolprofiles] Fatal error during startup:', error);
  process.exit(1);
});
