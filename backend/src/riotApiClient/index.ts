/**
 * Riot API Client.
 *
 * Owns every outgoing HTTP call to Riot: URL construction, API key attachment,
 * the per-call 10s timeout, the pre-flight rate-limit reservation, the bounded
 * 429 retry, and the mapping from HTTP outcomes onto `RiotApiResult`.
 *
 * Deliberately has NO ambient dependencies. The HTTP transport, the API key, the
 * rate limit manager, the sleep function, the clock and the timeout scheduler are
 * all injected (see `RiotApiClientOptions`), so no test needs the network or a
 * real timer. This module never reads `process.env` and never logs — the API key
 * must not reach a log sink, and logging of 401/403 (Requirement 9.5) belongs to
 * the caller, which never receives the key.
 *
 * Implements:
 *  - 2.1: Account-V1 get-by-riot-id resolves the PUUID (regional routing).
 *  - 2.2: Summoner-V4 get-by-puuid (platform routing).
 *  - 2.3: League-V4 get-by-puuid (platform routing).
 *  - 3.1: Match-V5 match-ids-by-puuid with an explicit `count` (regional routing).
 *  - 3.2: Match-V5 match-by-id (regional routing).
 *  - 2.6 / 9.4: a 10s timeout per call, surfaced as `{ kind: 'timeout' }`.
 *  - 4.1: the API key on every request, as the `X-Riot-Token` header.
 *  - 4.2: the key never appears in any returned result or thrown error.
 *  - 4.3-4.5: every request is reserved through `RateLimitManager.reserveSlot`
 *    first, and every response is fed back via `recordResponseHeaders`.
 *  - 4.6-4.8: HTTP 429 is retried at most twice, honoring `Retry-After` (or 5s).
 *
 * Decisions worth stating explicitly, because they define the contract:
 *
 * 1. TYPED RESULTS, NOT EXCEPTIONS, FOR EVERY EXPECTED OUTCOME. Including the
 *    >30s pre-flight case: `RateLimitExceededError` thrown by `reserveSlot`
 *    (Requirement 4.5) is caught and mapped to `{ kind: 'rate_limited' }` with no
 *    `retryAfterSeconds`, because Riot never told us a retry time — we declined to
 *    send. Letting it escape would give callers two error channels for one
 *    condition. Any OTHER error out of `reserveSlot` is a defect in the manager,
 *    not a lookup outcome, so it propagates untouched (it cannot carry the key:
 *    the manager is never given one).
 *
 * 2. ONLY 429 IS RETRIED. Requirements 4.6-4.8 scope automatic retry to 429.
 *    5xx, timeouts and network errors are returned on the first failure, because
 *    Requirement 9.3 gives the visitor a bounded, explicitly-initiated retry
 *    instead — retrying them here would multiply request volume against the very
 *    rate limits Requirement 4 protects, and would silently consume the 15s
 *    budget of Requirement 11.2.
 *
 * 3. UNMODELED HTTP STATUSES MAP TO `server_error` WITH STATUS 502. The result
 *    type models 404, 429, 401/403 and 500/502/503/504. Anything else — an
 *    unexpected 4xx such as 400 or 415, a 3xx that the transport surfaced instead
 *    of following, or a 2xx other than 200 — means we received a response we
 *    cannot interpret as data. `502 Bad Gateway` is the honest reading of exactly
 *    that, and it routes to the retriable `RIOT_UNAVAILABLE` path. The
 *    alternatives are worse: `not_found` would assert something false about the
 *    player, and `ok` would hand callers unvalidated data. The verbatim status is
 *    intentionally NOT preserved, since `server_error.status` is a closed union;
 *    callers only branch on `kind`.
 *
 * 4. A 200 WITH A BODY THAT DOES NOT PARSE AS JSON IS ALSO `server_error` 502,
 *    for the same reason as (3): the response exists but carries no usable data.
 *    It is never reported as `ok`, and it never throws.
 *
 * 5. RESPONSE BODIES ARE CAST, NOT VALIDATED. The DTOs below cover only the
 *    fields the pipeline consumes; Riot's real payloads are much wider. Field-level
 *    validation belongs downstream, where a missing field has a meaning (exclude
 *    the match, show "Unranked"); here it would only be able to discard the whole
 *    response.
 */

import {
  RateLimitExceededError,
  readHeader,
  type RateLimitHeaders,
  type RateLimitManager,
} from '../rateLimit';
import type { TimelineEventDto } from '../insight/buildPath';
import type { ClashPlayerDto, ClashTeamDto, ClashTournamentDto } from '../clashScouting/types';
import type { CurrentGameInfo } from '../liveGame/types';
import type { PlatformRoutingValue, RegionalRoutingValue } from '../region';
import { projectMatchDto } from './matchProjection';

export { projectMatchDto } from './matchProjection';

/** Requirement 2.6 / 9.4: per-call timeout. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Requirement 4.7: wait when a 429 carries no usable `Retry-After`. */
export const DEFAULT_RETRY_AFTER_SECONDS = 5;

/** Requirements 4.6-4.8: retries after the initial attempt, so at most 3 requests. */
export const MAX_RETRY_ATTEMPTS = 2;

/** The header Riot authenticates with (Requirement 4.1). */
export const API_KEY_HEADER = 'X-Riot-Token';

/**
 * Stable per-endpoint method identifiers. These are the `method` values passed to
 * the rate limit manager, so they must stay stable: they key the method-level
 * windows Riot reports per endpoint.
 */
export const RIOT_METHODS = {
  account: 'account',
  accountRegion: 'accountRegion',
  summoner: 'summoner',
  league: 'league',
  matchIds: 'matchIds',
  matchDetail: 'matchDetail',
  matchTimeline: 'matchTimeline',
  /** live-game: Spectator-V5 active-games-by-summoner. */
  spectator: 'spectator',
  /** live-game: Account-V1 accounts-by-puuid (per-participant Riot ID). */
  accountByPuuid: 'accountByPuuid',
  /** live-game: Champion-Mastery-V4 by-puuid-by-champion. */
  championMastery: 'championMastery',
  /** clash-scouting: Clash-V1 players-by-puuid. */
  clashPlayers: 'clashPlayers',
  /** clash-scouting: Clash-V1 teams. */
  clashTeam: 'clashTeam',
  /** clash-scouting: Clash-V1 tournaments-by-team (200/min — distinct from the 10/min tournaments endpoint on `ClashTournamentSource`). */
  clashTournamentsByTeam: 'clashTournamentsByTeam',
  /** clash-scouting: Champion-Mastery-V4 top-by-puuid. */
  championMasteryTop: 'championMasteryTop',
} as const;

export type RiotMethod = (typeof RIOT_METHODS)[keyof typeof RIOT_METHODS];

// ---------------------------------------------------------------------------
// DTOs — only the fields the pipeline actually consumes (see decision 5).
// ---------------------------------------------------------------------------

/** Account-V1. */
export interface AccountDto {
  puuid: string;
  gameName: string;
  tagLine: string;
}

/**
 * Account-V1 region-by-game-by-puuid. lookup-pipeline-fixes: response shape and
 * casing confirmed live against a real account (see the spec's design.md) —
 * `region` is a lowercase Platform_Routing_Value, e.g. `"euw1"`.
 */
export interface AccountRegionDto {
  puuid: string;
  game: string;
  region: string;
}

/** Summoner-V4. `id` is the encrypted summoner ID (Requirement 2.2). */
export interface SummonerDto {
  puuid: string;
  id?: string;
  summonerLevel: number;
  profileIconId: number;
}

/**
 * Champion-Mastery-V4 by-puuid-by-champion (live-game Requirement 2.3). Only the
 * two fields the Participant Enricher reads are modelled (decision 5).
 */
export interface ChampionMasteryDto {
  championId: number;
  championLevel: number;
  championPoints: number;
}

/** League-V4. `rank` is Riot's field name for the division (e.g. `"IV"`). */
export interface LeagueEntryDto {
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
}

/**
 * One participant of a Match-V5 match. Kept structurally close to Riot's shape
 * because the requester's row is located by matching `puuid` within
 * `info.participants`.
 */
export interface MatchParticipantDto {
  puuid: string;
  championName: string;
  /** clash-scouting Requirement 3.2: numeric champion id, joined against Champion-Mastery's `championId`. */
  championId?: number;
  /** Riot's normalized lane assignment; preferred over `role` when present. */
  teamPosition?: string;
  role?: string;
  /** 100 or 200; used to find the opposing participant in the same lane. */
  teamId?: number;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  visionScore: number;
  totalMinionsKilled?: number;
  neutralMinionsKilled?: number;
  /** Item_Slots 0-5, final inventory at game end. */
  item0?: number;
  item1?: number;
  item2?: number;
  item3?: number;
  item4?: number;
  item5?: number;
  /** Item_Slot 6, the trinket. */
  item6?: number;
  /** `match-detail-tabs` Requirement 6.2/6.3. */
  summoner1Id?: number;
  summoner2Id?: number;
  perks?: {
    statPerks?: { offense?: number; flex?: number; defense?: number };
    styles?: { description?: string; style?: number; selections?: { perk?: number }[] }[];
  };
  champLevel?: number;
  goldEarned?: number;
  totalDamageDealtToChampions?: number;
  /** Objective last-hits (item-timeline / match-rating). Always present in Match-V5. */
  turretKills?: number;
  dragonKills?: number;
  baronKills?: number;
  /** Multi-kill counts (match-rating pentakill bonus). Always present in Match-V5. */
  pentaKills?: number;
  /** The current, non-deprecated player-name fields; `summonerName` is empty on live matches. */
  riotIdGameName?: string;
  riotIdTagline?: string;
  /**
   * player-insights Requirement 14.1. Fourteen per-participant ping-count
   * fields Match-V5 already reports; consumed by `funFactsV2.ts`'s
   * most-used-ping fact. No new Riot API call — these are unread fields in a
   * response this codebase already fetches for every match.
   */
  onMyWayPings?: number;
  enemyMissingPings?: number;
  enemyVisionPings?: number;
  needVisionPings?: number;
  pushPings?: number;
  holdPings?: number;
  getBackPings?: number;
  assistMePings?: number;
  allInPings?: number;
  retreatPings?: number;
  dangerPings?: number;
  basicPings?: number;
  commandPings?: number;
  visionClearedPings?: number;
  /**
   * `match-detail-tabs` Requirement 12.1. Present in every queue, always `0`
   * outside queue 2400 (ARAM Mayhem) — verified live against real ARAM matches.
   */
  playerAugment1?: number;
  playerAugment2?: number;
  playerAugment3?: number;
  playerAugment4?: number;
  playerAugment5?: number;
  playerAugment6?: number;
}

/** Match-V5 match detail, in Riot's metadata/info shape. */
export interface MatchDto {
  metadata: {
    matchId: string;
    /** Participant PUUIDs, in the same order as `info.participants`. */
    participants: string[];
  };
  info: {
    /** Riot's numeric queue id; queue-type classification happens downstream. */
    queueId: number;
    gameMode?: string;
    /** Epoch ms. */
    gameStartTimestamp: number;
    /** Seconds. */
    gameDuration: number;
    participants: MatchParticipantDto[];
  };
}

/**
 * Match-V5 timeline (item-timeline feature). Only the fields the build-path
 * pipeline consumes are modelled (decision 5): the authoritative
 * Participant_Slot <-> PUUID mapping and the shop-event stream.
 *
 * `info.frameInterval` and `info.frames[].participantFrames` — the per-frame
 * gold, experience and position data — are deliberately NOT modelled. They are
 * out of scope for item-timeline (Requirement 7.2), and a response is 0.3-1 MB
 * of mostly that data; typing it would only invite its use.
 */
/**
 * player-insights Requirement 16.2. One participant's per-frame snapshot —
 * gold and CS only, the two fields the early-game deficit feedback reads.
 * Keyed by participant id AS A STRING in Riot's real payload
 * (`frame.participantFrames["1"]`, etc.); `MatchTimelineDto.info.frames`
 * models the map with that string-keyed shape unchanged.
 */
export interface ParticipantFrameDto {
  totalGold?: number;
  minionsKilled?: number;
  jungleMinionsKilled?: number;
}

export interface MatchTimelineDto {
  metadata: {
    matchId: string;
    participants: string[];
  };
  info: {
    /**
     * The authoritative Participant_Slot <-> PUUID mapping (item-timeline
     * Requirement 2.5). `metadata.participants` happens to be ordered so that
     * index + 1 equals the participant id (confirmed in the spec's task 1.1),
     * but relying on that ordering is forbidden — read this array.
     */
    participants: { participantId: number; puuid: string }[];
    frames: {
      timestamp: number;
      events: TimelineEventDto[];
      /**
       * player-insights Requirement 16.2. Absent on any frame this codebase
       * previously had no reason to keep (every frame before this spec).
       */
      participantFrames?: Record<string, ParticipantFrameDto>;
    }[];
  };
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type RiotApiResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'not_found' }
  | { kind: 'rate_limited'; retryAfterSeconds?: number }
  | { kind: 'server_error'; status: 500 | 502 | 503 | 504 }
  | { kind: 'auth_error'; status: 401 | 403 }
  | { kind: 'timeout' }
  | { kind: 'network_error' };

export interface RiotApiClient {
  getAccountByRiotId(
    region: RegionalRoutingValue,
    gameName: string,
    tagLine: string,
  ): Promise<RiotApiResult<AccountDto>>;
  /**
   * Account-V1 region-by-game-by-puuid. Issued against the Discovery_Region
   * host — `region` here carries no routing meaning of its own, since this
   * endpoint answers the same regardless of which regional host receives it
   * (lookup-pipeline-fixes Requirement 1.5).
   */
  getRegionByPuuid(
    region: RegionalRoutingValue,
    game: 'lol',
    puuid: string,
  ): Promise<RiotApiResult<AccountRegionDto>>;
  getSummonerByPuuid(platform: PlatformRoutingValue, puuid: string): Promise<RiotApiResult<SummonerDto>>;
  getLeagueEntriesByPuuid(
    platform: PlatformRoutingValue,
    puuid: string,
  ): Promise<RiotApiResult<LeagueEntryDto[]>>;
  getMatchIdsByPuuid(
    region: RegionalRoutingValue,
    puuid: string,
    count: number,
  ): Promise<RiotApiResult<string[]>>;
  getMatchById(region: RegionalRoutingValue, matchId: string): Promise<RiotApiResult<MatchDto>>;
  /**
   * Match-V5 timeline (item-timeline Requirement 1.2/1.3). Regional routing, and
   * the same 10s timeout, rate-limit reservation and 429 retry policy as every
   * other call. A 404 maps to `{ kind: 'not_found' }`, which the Build Path
   * Orchestrator reads as "build path unavailable" rather than an error.
   */
  getMatchTimeline(
    region: RegionalRoutingValue,
    matchId: string,
  ): Promise<RiotApiResult<MatchTimelineDto>>;
  /**
   * live-game Requirement 1.1. Spectator-V5 active-games-by-summoner, platform
   * routing. A 404 maps to `{ kind: 'not_found' }`, which the Live Game
   * Orchestrator reads as "not in a game" — a state, not an error (Requirement 1.2).
   */
  getActiveGameByPuuid(
    platform: PlatformRoutingValue,
    puuid: string,
  ): Promise<RiotApiResult<CurrentGameInfo>>;
  /** live-game Requirement 2.1. Account-V1 accounts-by-puuid, regional routing. */
  getAccountByPuuid(
    region: RegionalRoutingValue,
    puuid: string,
  ): Promise<RiotApiResult<AccountDto>>;
  /**
   * live-game Requirement 2.3. Champion-Mastery-V4 by-puuid-by-champion, platform
   * routing. A 404 (the player has never played the champion) maps to
   * `{ kind: 'not_found' }`; the enricher decides what that means for the card.
   */
  getChampionMastery(
    platform: PlatformRoutingValue,
    puuid: string,
    championId: number,
  ): Promise<RiotApiResult<ChampionMasteryDto>>;
  /** clash-scouting Requirement 1.1. Clash-V1 players-by-puuid, platform routing. An empty array is a valid `ok` result — no registrations is a state, not an error. */
  getClashPlayersByPuuid(
    platform: PlatformRoutingValue,
    puuid: string,
  ): Promise<RiotApiResult<ClashPlayerDto[]>>;
  /** clash-scouting Requirement 1.4. Clash-V1 teams, platform routing. A 404 means the referenced team id no longer exists. */
  getClashTeam(platform: PlatformRoutingValue, teamId: string): Promise<RiotApiResult<ClashTeamDto>>;
  /** clash-scouting Requirement 4.5. Clash-V1 tournaments-by-team (200/min) — NOT the 10/min tournaments endpoint, which lives only on `ClashTournamentSource`. */
  getClashTournamentsByTeam(
    platform: PlatformRoutingValue,
    teamId: string,
  ): Promise<RiotApiResult<ClashTournamentDto[]>>;
  /** clash-scouting Requirement 2.3. Champion-Mastery-V4 top-by-puuid, platform routing. */
  getChampionMasteryTop(
    platform: PlatformRoutingValue,
    puuid: string,
    count: number,
  ): Promise<RiotApiResult<ChampionMasteryDto[]>>;
}

// ---------------------------------------------------------------------------
// Injected collaborators
// ---------------------------------------------------------------------------

/**
 * The subset of a `fetch` `Response` this module needs. Narrower than `Response`
 * on purpose, so a test double is a three-property object rather than a mock of
 * the whole DOM type.
 */
export interface RiotHttpResponse {
  status: number;
  headers: RateLimitHeaders;
  json(): Promise<unknown>;
}

export interface RiotHttpRequestInit {
  method: 'GET';
  headers: Record<string, string>;
  signal: AbortSignal;
}

/** Injected HTTP transport; a real `fetch` satisfies this structurally. */
export type RiotHttpTransport = (url: string, init: RiotHttpRequestInit) => Promise<RiotHttpResponse>;

/**
 * Injected timeout mechanism: schedules `onElapsed` and returns a cancel
 * function. Injected rather than calling `setTimeout` inline so tests can fire
 * the timeout instantly or never fire it at all.
 */
export type TimeoutScheduler = (ms: number, onElapsed: () => void) => () => void;

const defaultTimeoutScheduler: TimeoutScheduler = (ms, onElapsed) => {
  const handle = setTimeout(onElapsed, ms);
  return () => {
    clearTimeout(handle);
  };
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export interface RiotApiClientOptions {
  /** HTTP transport. Required: this module must never reach for a global `fetch`. */
  fetch: RiotHttpTransport;
  /** Riot API key, from injected config. Never logged, never returned. */
  apiKey: string;
  /** Shared manager; every request reserves a slot through it first. */
  rateLimitManager: RateLimitManager;
  /** Injected delay used only for the 429 backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock. Not used for control flow; available for callers that pass one for consistency. */
  now?: () => number;
  /** Per-call timeout; defaults to `REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Injected timeout scheduler; defaults to a `setTimeout`-based one. */
  scheduleTimeout?: TimeoutScheduler;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const RIOT_HOST_SUFFIX = 'api.riotgames.com';

function baseUrl(routingValue: string): string {
  return `https://${routingValue}.${RIOT_HOST_SUFFIX}`;
}

/**
 * Parses `Retry-After` as a non-negative integer number of seconds
 * (Requirement 4.6). Anything else — an HTTP-date, a fractional or negative
 * value, garbage — is treated as absent, so the 5s default of Requirement 4.7
 * applies. Returning `undefined` rather than throwing is deliberate: a malformed
 * header must not turn a rate-limit response into a different failure.
 */
export function parseRetryAfterSeconds(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const text = raw.trim();
  if (text === '' || !/^\d+$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** True when the rejection reason is an abort, i.e. our own timeout firing. */
function isAbortReason(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) {
    return false;
  }
  const name = (reason as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** Outcome of one HTTP attempt, before 429 retry logic is applied. */
type AttemptOutcome<T> =
  | { kind: 'response'; result: RiotApiResult<T>; status: number; retryAfterSeconds?: number }
  | { kind: 'aborted' }
  | { kind: 'failed' };

class HttpRiotApiClient implements RiotApiClient {
  private readonly transport: RiotHttpTransport;
  private readonly apiKey: string;
  private readonly rateLimitManager: RateLimitManager;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly scheduleTimeout: TimeoutScheduler;

  constructor(options: RiotApiClientOptions) {
    this.transport = options.fetch;
    this.apiKey = options.apiKey;
    this.rateLimitManager = options.rateLimitManager;
    this.sleep = options.sleep ?? defaultSleep;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.scheduleTimeout = options.scheduleTimeout ?? defaultTimeoutScheduler;
  }

  /** Requirement 2.1. Regional routing; both Riot ID parts are URL-encoded. */
  async getAccountByRiotId(
    region: RegionalRoutingValue,
    gameName: string,
    tagLine: string,
  ): Promise<RiotApiResult<AccountDto>> {
    const url =
      `${baseUrl(region)}/riot/account/v1/accounts/by-riot-id/` +
      `${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
    return this.send<AccountDto>(url, region, RIOT_METHODS.account);
  }

  /**
   * lookup-pipeline-fixes Requirement 1.1. Issued against the Discovery_Region
   * host; not platform-routed, since the platform is what this call discovers.
   */
  async getRegionByPuuid(
    region: RegionalRoutingValue,
    game: 'lol',
    puuid: string,
  ): Promise<RiotApiResult<AccountRegionDto>> {
    const url =
      `${baseUrl(region)}/riot/account/v1/region/by-game/${encodeURIComponent(game)}` +
      `/by-puuid/${encodeURIComponent(puuid)}`;
    return this.send<AccountRegionDto>(url, region, RIOT_METHODS.accountRegion);
  }

  /** Requirement 2.2. Platform routing. */
  async getSummonerByPuuid(
    platform: PlatformRoutingValue,
    puuid: string,
  ): Promise<RiotApiResult<SummonerDto>> {
    const url = `${baseUrl(platform)}/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`;
    return this.send<SummonerDto>(url, platform, RIOT_METHODS.summoner);
  }

  /** Requirement 2.3. Platform routing. */
  async getLeagueEntriesByPuuid(
    platform: PlatformRoutingValue,
    puuid: string,
  ): Promise<RiotApiResult<LeagueEntryDto[]>> {
    const url = `${baseUrl(platform)}/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`;
    return this.send<LeagueEntryDto[]>(url, platform, RIOT_METHODS.league);
  }

  /** Requirement 3.1. Regional routing; `count` bounds the window. */
  async getMatchIdsByPuuid(
    region: RegionalRoutingValue,
    puuid: string,
    count: number,
  ): Promise<RiotApiResult<string[]>> {
    const query = new URLSearchParams({ count: String(count) });
    const url =
      `${baseUrl(region)}/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids` +
      `?${query.toString()}`;
    return this.send<string[]>(url, region, RIOT_METHODS.matchIds);
  }

  /**
   * Requirement 3.2. Regional routing.
   *
   * specs/match-cache/ Requirement 2.2: the raw response (50-120 KB, mostly
   * fields nothing reads) is projected down to the `MatchDto` shape here, so
   * every layer above — the in-memory cache and the persistent MatchStore —
   * holds the ~5 KB trimmed match.
   */
  async getMatchById(region: RegionalRoutingValue, matchId: string): Promise<RiotApiResult<MatchDto>> {
    const url = `${baseUrl(region)}/lol/match/v5/matches/${encodeURIComponent(matchId)}`;
    const result = await this.send<unknown>(url, region, RIOT_METHODS.matchDetail);
    return result.kind === 'ok' ? { kind: 'ok', data: projectMatchDto(result.data) } : result;
  }

  /** item-timeline Requirement 1.2/1.3. Regional routing; same `send()` policy as every other call. */
  async getMatchTimeline(
    region: RegionalRoutingValue,
    matchId: string,
  ): Promise<RiotApiResult<MatchTimelineDto>> {
    const url = `${baseUrl(region)}/lol/match/v5/matches/${encodeURIComponent(matchId)}/timeline`;
    return this.send<MatchTimelineDto>(url, region, RIOT_METHODS.matchTimeline);
  }

  /** live-game Requirement 1.1. Platform routing; same `send()` policy as every other call. */
  async getActiveGameByPuuid(
    platform: PlatformRoutingValue,
    puuid: string,
  ): Promise<RiotApiResult<CurrentGameInfo>> {
    const url = `${baseUrl(platform)}/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(puuid)}`;
    return this.send<CurrentGameInfo>(url, platform, RIOT_METHODS.spectator);
  }

  /** live-game Requirement 2.1. Regional routing. */
  async getAccountByPuuid(
    region: RegionalRoutingValue,
    puuid: string,
  ): Promise<RiotApiResult<AccountDto>> {
    const url = `${baseUrl(region)}/riot/account/v1/accounts/by-puuid/${encodeURIComponent(puuid)}`;
    return this.send<AccountDto>(url, region, RIOT_METHODS.accountByPuuid);
  }

  /** live-game Requirement 2.3. Platform routing. */
  async getChampionMastery(
    platform: PlatformRoutingValue,
    puuid: string,
    championId: number,
  ): Promise<RiotApiResult<ChampionMasteryDto>> {
    const url =
      `${baseUrl(platform)}/lol/champion-mastery/v4/champion-masteries/by-puuid/` +
      `${encodeURIComponent(puuid)}/by-champion/${encodeURIComponent(String(championId))}`;
    return this.send<ChampionMasteryDto>(url, platform, RIOT_METHODS.championMastery);
  }

  /** clash-scouting Requirement 1.1. Platform routing. */
  async getClashPlayersByPuuid(
    platform: PlatformRoutingValue,
    puuid: string,
  ): Promise<RiotApiResult<ClashPlayerDto[]>> {
    const url = `${baseUrl(platform)}/lol/clash/v1/players/by-puuid/${encodeURIComponent(puuid)}`;
    return this.send<ClashPlayerDto[]>(url, platform, RIOT_METHODS.clashPlayers);
  }

  /** clash-scouting Requirement 1.4. Platform routing. */
  async getClashTeam(platform: PlatformRoutingValue, teamId: string): Promise<RiotApiResult<ClashTeamDto>> {
    const url = `${baseUrl(platform)}/lol/clash/v1/teams/${encodeURIComponent(teamId)}`;
    return this.send<ClashTeamDto>(url, platform, RIOT_METHODS.clashTeam);
  }

  /** clash-scouting Requirement 4.5. Platform routing; 200/min, distinct from the 10/min tournaments endpoint. */
  async getClashTournamentsByTeam(
    platform: PlatformRoutingValue,
    teamId: string,
  ): Promise<RiotApiResult<ClashTournamentDto[]>> {
    const url = `${baseUrl(platform)}/lol/clash/v1/tournaments/by-team/${encodeURIComponent(teamId)}`;
    return this.send<ClashTournamentDto[]>(url, platform, RIOT_METHODS.clashTournamentsByTeam);
  }

  /** clash-scouting Requirement 2.3. Platform routing; `count` bounds the returned champion pool. */
  async getChampionMasteryTop(
    platform: PlatformRoutingValue,
    puuid: string,
    count: number,
  ): Promise<RiotApiResult<ChampionMasteryDto[]>> {
    const query = new URLSearchParams({ count: String(count) });
    const url =
      `${baseUrl(platform)}/lol/champion-mastery/v4/champion-masteries/by-puuid/` +
      `${encodeURIComponent(puuid)}/top?${query.toString()}`;
    return this.send<ChampionMasteryDto[]>(url, platform, RIOT_METHODS.championMasteryTop);
  }

  /**
   * One logical Riot call: pre-flight reservation, request, response mapping, and
   * the bounded 429 retry (Requirements 4.3-4.8).
   *
   * The loop runs at most `MAX_RETRY_ATTEMPTS + 1` times, and only a 429 causes
   * another iteration; every other outcome returns immediately (decision 2).
   * Each retry re-enters `reserveSlot`, so retries are accounted for against the
   * rate-limit windows exactly like first attempts.
   */
  private async send<T>(url: string, routingValue: string, method: RiotMethod): Promise<RiotApiResult<T>> {
    let lastRetryAfterSeconds: number | undefined;

    for (let attempt = 0; ; attempt += 1) {
      // Requirement 4.5: the >30s pre-flight refusal becomes a typed result.
      try {
        await this.rateLimitManager.reserveSlot(routingValue, method);
      } catch (error) {
        if (error instanceof RateLimitExceededError) {
          return { kind: 'rate_limited' };
        }
        throw error;
      }

      const outcome = await this.attempt<T>(url, routingValue, method);

      if (outcome.kind === 'aborted') {
        return { kind: 'timeout' };
      }
      if (outcome.kind === 'failed') {
        return { kind: 'network_error' };
      }
      if (outcome.status !== 429) {
        return outcome.result;
      }

      lastRetryAfterSeconds = outcome.retryAfterSeconds;

      // Requirement 4.8: retries are capped; the last 429 is reported as-is.
      if (attempt >= MAX_RETRY_ATTEMPTS) {
        return { kind: 'rate_limited', retryAfterSeconds: lastRetryAfterSeconds };
      }

      // Requirements 4.6/4.7: honor `Retry-After`, else wait 5s.
      const waitSeconds = lastRetryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
      await this.sleep(waitSeconds * 1000);
    }
  }

  /**
   * A single HTTP attempt with the API key header and the timeout armed
   * (Requirements 4.1, 2.6). The timeout is always cancelled, so a completed
   * request never leaves a pending timer behind.
   */
  private async attempt<T>(
    url: string,
    routingValue: string,
    method: RiotMethod,
  ): Promise<AttemptOutcome<T>> {
    const controller = new AbortController();
    let timedOut = false;
    const cancelTimeout = this.scheduleTimeout(this.timeoutMs, () => {
      timedOut = true;
      controller.abort();
    });

    let response: RiotHttpResponse;
    try {
      response = await this.transport(url, {
        method: 'GET',
        headers: { [API_KEY_HEADER]: this.apiKey },
        signal: controller.signal,
      });
    } catch (error) {
      // A rejection is either our abort (timeout) or a transport-level failure
      // with no HTTP response at all (Requirement 9.9). The error object is
      // never inspected further and never surfaced, so nothing it may carry can
      // reach a caller.
      return timedOut || isAbortReason(error) ? { kind: 'aborted' } : { kind: 'failed' };
    } finally {
      cancelTimeout();
    }

    // A transport that resolves despite the abort still counts as a timeout: the
    // 10s budget was spent.
    if (timedOut) {
      return { kind: 'aborted' };
    }

    // Requirement 4.3: reconcile the tracked windows with what Riot reported,
    // for every response including errors — Riot counts rejected requests too.
    this.rateLimitManager.recordResponseHeaders(routingValue, method, response.headers);

    const status = response.status;

    if (status === 200) {
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        // Decision 4: unparseable body on a 200.
        return { kind: 'response', result: { kind: 'server_error', status: 502 }, status };
      }
      return { kind: 'response', result: { kind: 'ok', data: data as T }, status };
    }

    if (status === 404) {
      return { kind: 'response', result: { kind: 'not_found' }, status };
    }

    if (status === 429) {
      return {
        kind: 'response',
        result: { kind: 'rate_limited' },
        status,
        retryAfterSeconds: parseRetryAfterSeconds(readHeader(response.headers, 'Retry-After')),
      };
    }

    if (status === 401 || status === 403) {
      return { kind: 'response', result: { kind: 'auth_error', status }, status };
    }

    if (status === 500 || status === 502 || status === 503 || status === 504) {
      return { kind: 'response', result: { kind: 'server_error', status }, status };
    }

    // Decision 3: every unmodeled status.
    return { kind: 'response', result: { kind: 'server_error', status: 502 }, status };
  }
}

export function createRiotApiClient(options: RiotApiClientOptions): RiotApiClient {
  return new HttpRiotApiClient(options);
}
