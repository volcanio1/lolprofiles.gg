/**
 * The Enrichment_Call helper (lookup-pipeline-fixes Requirement 4.1/4.4/4.5).
 *
 * Translates a `RiotApiResult<T>` into `T | null` with no error channel at all —
 * there is no failure branch to inspect, which is what makes "no error code,
 * routing decision, or pipeline-halting condition derives from this call"
 * checkable by looking at the return type rather than auditing every call site.
 *
 * Extracted to its own module so both the lookup pipeline (`orchestrator/index.ts`)
 * and the live-game Participant Enricher use the one definition of "this call's
 * failure is not an error".
 */

import type { RiotApiResult } from '../riotApiClient';

export async function enrich<T>(fetch: () => Promise<RiotApiResult<T>>): Promise<T | null> {
  const result = await fetch();
  return result.kind === 'ok' ? result.data : null;
}
