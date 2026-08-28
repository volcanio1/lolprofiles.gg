/**
 * The Clash-V1 tournaments endpoint boundary (clash-scouting Requirement 4.1).
 *
 * `getClashTournaments` is granted **10 requests per minute** — three orders of
 * magnitude below every other endpoint this application touches, and below what
 * the Rate_Limit_Manager's 30-second pre-flight ceiling can absorb. It is
 * therefore kept OFF `RiotApiClient`'s request-path surface entirely: only the
 * Tournament Refresher is given a `ClashTournamentSource`, and the Scouting
 * Orchestrator's dependency type does not include one, so a request-path call is
 * a compile error rather than a code-review finding.
 *
 * `tournaments-by-team` (200/min) is a different endpoint with a different limit
 * and lives on `RiotApiClient` as `getClashTournamentsByTeam` — do not conflate
 * the two.
 */

import type { PlatformRoutingValue } from '../region';
import type { RiotApiResult } from '../riotApiClient';
import type { ClashTournamentDto } from './types';

export interface ClashTournamentSource {
  getClashTournaments(platform: PlatformRoutingValue): Promise<RiotApiResult<ClashTournamentDto[]>>;
}
