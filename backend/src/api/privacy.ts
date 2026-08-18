/**
 * API layer — `POST /api/privacy/delete`.
 *
 * The data subject's deletion channel (Requirements 12.5/12.6). It delegates
 * entirely to `CacheStore.deleteByPuuid`, which owns the removal-versus-scrubbing
 * rules, and reports the confirmation design.md declares: `{ found, deletedAt }`.
 *
 * Implements:
 *  - 12.5: cached data for the PUUID is deleted, and the requester receives a
 *    confirmation that the deletion completed. Deletion is synchronous, so it
 *    completes far inside the 30-day obligation and `deletedAt` is the moment it
 *    finished.
 *  - 12.6: a PUUID with no cached data is answered with `found: false` and a 200 —
 *    explicitly NOT an error.
 *
 * ---------------------------------------------------------------------------
 * SECURITY: THIS ROUTE IS UNAUTHENTICATED, AND THE EXPOSURE IS REAL
 * ---------------------------------------------------------------------------
 *
 * The requirements define no authentication or identity proof for a deletion
 * request, so none is invented here. Stating the consequence plainly rather than
 * leaving it implicit:
 *
 * Anyone who can reach this endpoint can submit any PUUID and cause its cached
 * data to be evicted, and its participant records inside retained match details to
 * be irreversibly redacted (`deleteByPuuid` mutates the stored object graph in
 * place, by design — see the Cache Store's scrubbing decision). The blast radius
 * is bounded but not nil:
 *
 *  - Evicted entries are all re-fetchable, so no data is permanently lost. The
 *    cost is cache misses, which spend the SHARED Riot rate-limit budget on the
 *    next lookup for that player.
 *  - Scrubbing is NOT recoverable from cache: a redacted match detail stays
 *    redacted, so that player's rows in already-cached matches are gone until
 *    those matches are fetched again. Since match details are cached indefinitely
 *    (Requirement 10.4) and are only re-fetched on a cache miss, a scrubbed entry
 *    is effectively permanent for as long as it remains cached.
 *  - Repeated calls across many PUUIDs are a cheap way to degrade cache hit rates
 *    for everyone.
 *
 * A deployment exposing this publicly should put identity proof in front of it —
 * proving control of the Riot account whose PUUID is being deleted is the
 * behavior Requirement 12.5's "data subject requests removal" implies, but the
 * requirements do not specify a mechanism and inventing one is outside this task's
 * scope. Flagged in the implementation log's open items for an explicit decision.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. THE RESPONSE IS EXACTLY `{ found, deletedAt }`. `PuuidDeletionResult` also
 *    carries `removedEntryCount` and `scrubbedMatchDetailCount`, but design.md's
 *    route contract declares only the two fields and the counts would tell an
 *    unauthenticated caller how much data we hold about a given player — a small
 *    but gratuitous information leak. They stay internal, where the Cache Store's
 *    own tests assert them.
 *
 * 2. `deletedAt` IS SET WHEN THE DELETION COMPLETES, NOT WHEN THE REQUEST ARRIVED,
 *    because Requirement 12.5's confirmation is that the deletion *has been*
 *    completed. The clock is injected, as everywhere else in this build.
 *
 * 3. A BLANK OR MISSING PUUID IS A 400, NOT A `found: false`. Requirement 12.6
 *    covers a well-formed request for a PUUID we happen to hold nothing for; it
 *    does not ask us to pretend an empty request was a valid one. The Cache Store
 *    already treats an empty PUUID as "no data" rather than as a wildcard, so this
 *    check is about answering the requester honestly, not about safety.
 */

import type { RequestHandler } from 'express';
import type { CacheStore } from '../cache';
import { missingFieldError } from './errors';

export interface PrivacyRouteDependencies {
  cache: CacheStore;
  /** Injected clock; shared with the cache store and orchestrator. */
  now: () => number;
}

/** design.md's declared confirmation body (decision 1). */
export interface DeletionConfirmation {
  found: boolean;
  deletedAt: string;
}

/**
 * `POST /api/privacy/delete`. Always 200 for a well-formed request, whether or not
 * data existed (Requirement 12.6), and idempotent because `deleteByPuuid` is.
 */
export function createPrivacyDeleteHandler(deps: PrivacyRouteDependencies): RequestHandler {
  return async (req, res, next) => {
    try {
      const body: unknown = req.body;
      const rawPuuid = body !== null && typeof body === 'object' ? (body as Record<string, unknown>).puuid : undefined;

      // Decision 3.
      if (typeof rawPuuid !== 'string' || rawPuuid.trim().length === 0) {
        const response = missingFieldError('puuid', 'Provide the PUUID whose cached data should be deleted.');
        res.status(response.status).json(response.body);
        return;
      }

      // Requirements 12.4/12.5: the Cache Store owns removal vs in-place scrubbing.
      const result = await deps.cache.deleteByPuuid(rawPuuid.trim());

      // Requirements 12.5/12.6: confirmation either way, never an error.
      const confirmation: DeletionConfirmation = {
        found: result.found,
        deletedAt: new Date(deps.now()).toISOString(), // decision 2
      };
      res.status(200).json(confirmation);
    } catch (error) {
      next(error);
    }
  };
}
