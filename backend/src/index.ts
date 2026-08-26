/**
 * Composition root.
 *
 * The only place where the concrete dependency graph is built. Every module below
 * takes its collaborators as parameters, so this file is the single spot that
 * decides what "real" means: the wall clock, the global `fetch`, the in-memory
 * cache, and the API key from the environment.
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
 * Note that this assembly is nominally task 18.1's, but `createApp` requires its
 * dependencies, so the backend half had to land with the API layer to keep the
 * build working. Task 18.1 retains the frontend-to-backend integration.
 */

import { loadConfig } from './config';
import { createApp } from './app';
import { createInMemoryCacheStore } from './cache';
import { createLookupOrchestrator } from './orchestrator';
import { createRateLimitManager } from './rateLimit';
import { createRiotApiClient, type RiotHttpTransport } from './riotApiClient';
import 'dotenv/config';
// Load config first so misconfiguration fails fast, before the app starts.
// This is also the only read of the API key; it is passed to the Riot API Client
// and never travels anywhere else.
const config = loadConfig();

const now = () => Date.now();

const cache = createInMemoryCacheStore({ now });
const rateLimitManager = createRateLimitManager({ now });

/** The real HTTP transport. A `Response` structurally satisfies `RiotHttpResponse`. */
const transport: RiotHttpTransport = (url, init) => fetch(url, init);

const riotApiClient = createRiotApiClient({
  fetch: transport,
  apiKey: config.riotApiKey,
  rateLimitManager,
  now,
});

const orchestrator = createLookupOrchestrator({ cache, riotApiClient, now });

const app = createApp({
  orchestrator,
  cache,
  now,
  allowedOrigins: config.allowedOrigins,
  dataDragonVersion: config.dataDragonVersion,
});

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on port ${config.port}`);
});
