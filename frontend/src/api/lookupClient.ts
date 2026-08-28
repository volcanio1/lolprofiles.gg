/**
 * Backend API client.
 *
 * The only module that performs network I/O. It calls lolprofiles.gg's own
 * backend — never Riot directly, which is what makes Requirement 4.2 hold by
 * construction: the browser has no credential and no Riot endpoint to call.
 *
 * Implements the client side of:
 *  - 9.1-9.5, 9.8, 9.9: every response, including a total transport failure, is
 *    narrowed to a typed outcome carrying an `ErrorCode`, so the UI never has to
 *    interpret a status code or a raw body.
 *  - 9.7: it always settles. There is no path on which the returned promise
 *    neither resolves nor rejects, which is what lets the caller clear the loading
 *    indicator in a `finally`.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. IT NEVER REJECTS. Every failure — non-2xx, unparseable body, DNS failure,
 *    abort — becomes `{ kind: 'error', error: ApiErrorPayload }`. A thrown
 *    exception and a returned error would be two channels for one condition, and
 *    the caller would have to handle both to satisfy Requirement 9.7.
 *
 * 2. THE CLIENT TIMEOUT IS LONGER THAN THE BACKEND'S BUDGET. Requirement 11.2
 *    allows the backend 15 seconds for a fresh lookup, and Requirement 2.6 allows
 *    each Riot call 10 seconds within that. A client timeout at or below 15s would
 *    abort lookups the backend was about to complete successfully, converting
 *    slow-but-working into broken. `REQUEST_TIMEOUT_MS` is therefore 20s: long
 *    enough to never pre-empt the backend, short enough that a hung connection
 *    still resolves into Requirement 9.4's timeout state rather than spinning
 *    forever.
 *
 * 3. THE ERROR ENVELOPE IS VALIDATED, NOT TRUSTED. A response that is not the
 *    expected shape — an HTML error page from a proxy, an empty 502, a JSON body
 *    without `error.code` — is mapped onto a synthesized payload derived from the
 *    HTTP status. Rendering `undefined` as a message is worse than rendering a
 *    generic one, and the frontend cannot assume it is always talking to a healthy
 *    instance of our own backend.
 *
 * 4. A 200 WITH AN UNREADABLE BODY IS AN ERROR, NOT AN EMPTY REPORT. The UI would
 *    otherwise render a report-shaped blank, which looks like a player with no
 *    data rather than a failure.
 */

import { apiBaseUrl } from '../config';
import { isAnswerableSuggestionQuery, MAX_SUGGESTIONS } from '../domain/suggestions';
import type {
  ApiErrorPayload,
  BuildPathEntry,
  BuildPathResponse,
  CachedReportResponse,
  ErrorCode,
  LiveGameLobby,
  LiveGameResponse,
  LiveParticipantCard,
  PlayerSuggestion,
  ProfileReport,
  RiotIdParts,
} from './types';

/** Decision 2. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Requirement 9.8's floor, applied when the backend does not state one. */
export const DEFAULT_COOLDOWN_SECONDS = 5;

export interface LookupRequest {
  riotId: string;
  /** lookup-pipeline-fixes Requirement 2.4/2.5: diagnostic only, never set by the default search UI. */
  platformOverride?: string;
}

export type LookupOutcome =
  | { kind: 'success'; report: ProfileReport }
  | { kind: 'error'; error: ApiErrorPayload };

/** The subset of `fetch` this module needs, so tests inject a plain function. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface LookupClientOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Fallback messages for statuses the backend did not describe (decision 3). */
const SYNTHESIZED_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: 'That request could not be understood. Check the Riot ID and try again.',
  PLAYER_NOT_FOUND: 'No player was found for that Riot ID.',
  NO_LOL_ACCOUNT: 'That Riot account exists, but has no League of Legends play history.',
  UNSUPPORTED_PLATFORM: "This player's League of Legends region is not one this site supports yet.",
  RIOT_UNAVAILABLE: "Riot's services are temporarily unavailable. Please try again in a moment.",
  TIMEOUT: 'The lookup timed out before Riot responded. Please try again.',
  RATE_LIMITED: `This lookup was rate-limited. Please wait ${String(DEFAULT_COOLDOWN_SECONDS)} seconds and try again.`,
  AUTH_FAILURE: 'This service is temporarily unavailable. Please try again later.',
  NETWORK_ERROR: 'A connection error occurred. Please check your connection and try again.',
  MATCH_HISTORY_UNAVAILABLE: 'Match history could not be retrieved for this player.',
};

/** Decision 3: infer a code from the status when the body cannot tell us. */
export function errorCodeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'VALIDATION_FAILED';
    case 404:
      return 'PLAYER_NOT_FOUND';
    case 429:
      return 'RATE_LIMITED';
    case 502:
      return 'NETWORK_ERROR';
    case 504:
      return 'TIMEOUT';
    default:
      return 'RIOT_UNAVAILABLE';
  }
}

/** Which synthesized codes are worth offering a retry for (Requirements 9.3/9.8/9.9). */
function retriableByDefault(code: ErrorCode): boolean {
  return code === 'RIOT_UNAVAILABLE' || code === 'RATE_LIMITED' || code === 'NETWORK_ERROR' || code === 'MATCH_HISTORY_UNAVAILABLE';
}

export function synthesizedError(code: ErrorCode): ApiErrorPayload {
  const error: ApiErrorPayload = {
    code,
    message: SYNTHESIZED_MESSAGES[code],
    retriable: retriableByDefault(code),
  };
  if (code === 'RATE_LIMITED') {
    error.retryAfterSeconds = DEFAULT_COOLDOWN_SECONDS;
  }
  return error;
}

/** Narrows an untrusted parsed body to an `ApiErrorPayload` (decision 3). */
export function readErrorPayload(body: unknown, status: number): ApiErrorPayload {
  const fallback = synthesizedError(errorCodeForStatus(status));
  if (body === null || typeof body !== 'object') {
    return fallback;
  }
  const candidate = (body as { error?: unknown }).error;
  if (candidate === null || typeof candidate !== 'object') {
    return fallback;
  }
  const raw = candidate as Record<string, unknown>;
  const code = typeof raw.code === 'string' ? (raw.code as ErrorCode) : fallback.code;
  const known = Object.prototype.hasOwnProperty.call(SYNTHESIZED_MESSAGES, code);
  const resolvedCode = known ? code : fallback.code;

  const payload: ApiErrorPayload = {
    code: resolvedCode,
    message:
      typeof raw.message === 'string' && raw.message.trim().length > 0
        ? raw.message
        : SYNTHESIZED_MESSAGES[resolvedCode],
    retriable: typeof raw.retriable === 'boolean' ? raw.retriable : retriableByDefault(resolvedCode),
  };

  if (typeof raw.retryAfterSeconds === 'number' && Number.isFinite(raw.retryAfterSeconds)) {
    payload.retryAfterSeconds = raw.retryAfterSeconds;
  } else if (resolvedCode === 'RATE_LIMITED') {
    payload.retryAfterSeconds = DEFAULT_COOLDOWN_SECONDS;
  }
  if (typeof raw.maxRetries === 'number' && Number.isFinite(raw.maxRetries)) {
    payload.maxRetries = raw.maxRetries;
  }
  if (typeof raw.gameName === 'string') {
    payload.gameName = raw.gameName;
  }
  if (typeof raw.tagLine === 'string') {
    payload.tagLine = raw.tagLine;
  }
  // Requirement 5.3: the platform Riot itself reported, on UNSUPPORTED_PLATFORM.
  if (typeof raw.platform === 'string') {
    payload.platform = raw.platform;
  }
  if (typeof raw.validationRule === 'string') {
    payload.validationRule = raw.validationRule;
  }
  if (typeof raw.field === 'string') {
    payload.field = raw.field;
  }
  return payload;
}

/** True when a parsed 200 body is shaped enough like a report to render. */
export function isProfileReport(body: unknown): body is ProfileReport {
  if (body === null || typeof body !== 'object') {
    return false;
  }
  const candidate = body as Partial<ProfileReport>;
  return (
    typeof candidate.puuid === 'string' &&
    (typeof candidate.summonerLevel === 'number' || candidate.summonerLevel === null) &&
    candidate.stats !== null &&
    typeof candidate.stats === 'object' &&
    // profile-sidebar Requirements 7/8/10 — a report without these is a
    // version-skewed backend, not a report this frontend can render.
    candidate.statsByQueue !== null &&
    typeof candidate.statsByQueue === 'object' &&
    candidate.rolePerformanceByQueue !== null &&
    typeof candidate.rolePerformanceByQueue === 'object' &&
    candidate.premadesByQueue !== null &&
    typeof candidate.premadesByQueue === 'object' &&
    Array.isArray(candidate.rankHistory) &&
    Array.isArray(candidate.funFacts) &&
    Array.isArray(candidate.recommendations)
  );
}

// ---------------------------------------------------------------------------
// item-timeline: GET /api/match/:matchId/build-path
// ---------------------------------------------------------------------------

export type BuildPathOutcome = BuildPathResponse | { kind: 'error'; error: ApiErrorPayload };

function isBuildPathEntry(value: unknown): value is BuildPathEntry {
  const entry = value as Partial<BuildPathEntry> | null;
  return (
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.itemId === 'number' &&
    Number.isFinite(entry.itemId) &&
    typeof entry.timestamp === 'number' &&
    Number.isFinite(entry.timestamp) &&
    (entry.soldAt === undefined || (typeof entry.soldAt === 'number' && Number.isFinite(entry.soldAt)))
  );
}

/** Narrows an untrusted 200 body to a `BuildPathResponse`, or `null` when it is not one. */
export function readBuildPathResponse(body: unknown): BuildPathResponse | null {
  if (body === null || typeof body !== 'object') {
    return null;
  }
  const candidate = body as Record<string, unknown>;
  if (candidate.kind === 'build_path') {
    if (!Array.isArray(candidate.buildPath) || !candidate.buildPath.every(isBuildPathEntry)) {
      return null;
    }
    if (typeof candidate.reconciled !== 'boolean') {
      return null;
    }
    const skillOrder = Array.isArray(candidate.skillOrder)
      ? candidate.skillOrder.filter((slot): slot is number => typeof slot === 'number' && slot >= 1 && slot <= 4)
      : [];
    return { kind: 'build_path', buildPath: candidate.buildPath, skillOrder, reconciled: candidate.reconciled };
  }
  if (candidate.kind === 'unavailable' && (candidate.reason === 'no_timeline' || candidate.reason === 'participant_absent')) {
    return { kind: 'unavailable', reason: candidate.reason };
  }
  return null;
}

/**
 * `GET /api/match/:matchId/build-path`. Same contract as `lookupProfile`: never
 * rejects, always settles. `unavailable` is a normal outcome, not an error
 * (item-timeline Requirement 1.5 / 6.1).
 */
export async function fetchBuildPath(
  matchId: string,
  riotId: RiotIdParts,
  options: LookupClientOptions = {},
): Promise<BuildPathOutcome> {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const baseUrl = options.baseUrl ?? apiBaseUrl;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const query = new URLSearchParams({ gameName: riotId.gameName, tagLine: riotId.tagLine });
    const url = `${baseUrl}/api/match/${encodeURIComponent(matchId)}/build-path?${query.toString()}`;

    let response: Response;
    try {
      response = await doFetch(url, { method: 'GET', signal: controller.signal });
    } catch {
      return { kind: 'error', error: synthesizedError(timedOut ? 'TIMEOUT' : 'NETWORK_ERROR') };
    }

    let parsed: unknown;
    let parseFailed = false;
    try {
      parsed = await response.json();
    } catch {
      parseFailed = true;
    }

    if (response.ok) {
      const narrowed = parseFailed ? null : readBuildPathResponse(parsed);
      return narrowed ?? { kind: 'error', error: synthesizedError('RIOT_UNAVAILABLE') };
    }

    return {
      kind: 'error',
      error: parseFailed
        ? synthesizedError(errorCodeForStatus(response.status))
        : readErrorPayload(parsed, response.status),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// autofill-search: GET /api/players/suggest
// ---------------------------------------------------------------------------

/** Narrows an untrusted 200 body to `PlayerSuggestion[]`, dropping any malformed row. */
export function readSuggestions(body: unknown): PlayerSuggestion[] {
  if (!Array.isArray(body)) {
    return [];
  }
  const suggestions: PlayerSuggestion[] = [];
  for (const raw of body) {
    if (raw === null || typeof raw !== 'object') {
      continue;
    }
    const row = raw as Record<string, unknown>;
    if (typeof row.gameName !== 'string' || typeof row.tagLine !== 'string' || typeof row.region !== 'string') {
      continue;
    }
    suggestions.push({
      gameName: row.gameName,
      tagLine: row.tagLine,
      profileIconId:
        typeof row.profileIconId === 'number' && Number.isFinite(row.profileIconId) ? row.profileIconId : null,
      region: row.region,
    });
  }
  return suggestions.slice(0, MAX_SUGGESTIONS);
}

/**
 * `GET /api/players/suggest`. Autocomplete rows for a name prefix, drawn only
 * from players this site has already looked up.
 *
 * Its failure value is simply `[]` — a failed autocomplete must be invisible
 * (Requirement 3.7), so there is no error channel at all. It also mirrors the
 * endpoint's own guards (trim, `MIN_QUERY_LENGTH`, no `#`) and returns `[]`
 * WITHOUT a request when they fail, so a below-threshold keystroke costs nothing
 * (Requirement 1.5). The caller passes an `AbortSignal` and aborts it when the
 * query changes; an aborted request resolves to `[]` like any other failure.
 */
export async function fetchSuggestions(
  query: string,
  options: { baseUrl?: string; fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<PlayerSuggestion[]> {
  const trimmed = query.trim();
  if (!isAnswerableSuggestionQuery(trimmed)) {
    return [];
  }

  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const baseUrl = options.baseUrl ?? apiBaseUrl;
  const url = `${baseUrl}/api/players/suggest?q=${encodeURIComponent(trimmed)}`;

  let response: Response;
  try {
    response = await doFetch(url, { method: 'GET', signal: options.signal });
  } catch {
    return [];
  }

  if (!response.ok) {
    return [];
  }

  try {
    return readSuggestions(await response.json());
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// autofill-search: GET /api/players/report (cached full-report snapshot)
// ---------------------------------------------------------------------------

/** Narrows an untrusted 200 body to a `CachedReportResponse`; anything unexpected is a miss. */
export function readCachedReport(body: unknown): CachedReportResponse {
  if (body !== null && typeof body === 'object') {
    const candidate = body as Record<string, unknown>;
    if (
      candidate.source === 'cache' &&
      typeof candidate.fetchedAt === 'string' &&
      isProfileReport(candidate.report)
    ) {
      return { source: 'cache', report: candidate.report, fetchedAt: candidate.fetchedAt };
    }
  }
  return { source: 'miss' };
}

/**
 * `GET /api/players/report`. The stored `ProfileReport` for a player, when this
 * site has a fresh one — used only when a suggestion is picked from the dropdown
 * (autofill-search Requirement 9). Never rejects: `{ source: 'miss' }` on any
 * non-200, malformed body, abort, or blank input, and the caller then runs a
 * normal live lookup.
 */
export async function fetchCachedReport(
  gameName: string,
  tagLine: string,
  options: { baseUrl?: string; fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<CachedReportResponse> {
  const trimmedGameName = gameName.trim();
  const trimmedTagLine = tagLine.trim();
  if (trimmedGameName === '' || trimmedTagLine === '') {
    return { source: 'miss' };
  }

  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const baseUrl = options.baseUrl ?? apiBaseUrl;
  const query = new URLSearchParams({ gameName: trimmedGameName, tagLine: trimmedTagLine });

  let response: Response;
  try {
    response = await doFetch(`${baseUrl}/api/players/report?${query.toString()}`, {
      method: 'GET',
      signal: options.signal,
    });
  } catch {
    return { source: 'miss' };
  }

  if (!response.ok) {
    return { source: 'miss' };
  }

  try {
    return readCachedReport(await response.json());
  } catch {
    return { source: 'miss' };
  }
}

/**
 * `POST /api/lookup`. Never rejects (decision 1) and always settles, which is what
 * Requirement 9.7 relies on.
 */
export async function lookupProfile(
  request: LookupRequest,
  options: LookupClientOptions = {},
): Promise<LookupOutcome> {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const baseUrl = options.baseUrl ?? apiBaseUrl;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const body: LookupRequest = { riotId: request.riotId };
    if (request.platformOverride !== undefined && request.platformOverride.length > 0) {
      body.platformOverride = request.platformOverride;
    }

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/api/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      // Requirement 9.4 vs 9.9: our own abort is a timeout; anything else is a
      // transport failure with no response at all.
      return { kind: 'error', error: synthesizedError(timedOut ? 'TIMEOUT' : 'NETWORK_ERROR') };
    }

    let parsed: unknown;
    let parseFailed = false;
    try {
      parsed = await response.json();
    } catch {
      parseFailed = true;
    }

    if (response.ok) {
      // Decision 4.
      if (parseFailed || !isProfileReport(parsed)) {
        return { kind: 'error', error: synthesizedError('RIOT_UNAVAILABLE') };
      }
      return { kind: 'success', report: parsed };
    }

    return {
      kind: 'error',
      error: parseFailed ? synthesizedError(errorCodeForStatus(response.status)) : readErrorPayload(parsed, response.status),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// live-game: GET /api/live-game
// ---------------------------------------------------------------------------

export type LiveGameOutcome = LiveGameResponse | { kind: 'error'; error: ApiErrorPayload };

function isLiveParticipantCard(raw: unknown): raw is LiveParticipantCard {
  if (raw === null || typeof raw !== 'object') {
    return false;
  }
  const card = raw as Record<string, unknown>;
  return (
    typeof card.puuid === 'string' &&
    typeof card.teamId === 'number' &&
    typeof card.championId === 'number' &&
    typeof card.isBot === 'boolean' &&
    Array.isArray(card.perkIds)
  );
}

/** Narrows an untrusted 200 body to a `LiveGameResponse`, or `null` when it is not one. */
export function readLiveGameResponse(body: unknown): LiveGameResponse | null {
  if (body === null || typeof body !== 'object') {
    return null;
  }
  const candidate = body as Record<string, unknown>;
  if (candidate.kind === 'not_in_game') {
    return { kind: 'not_in_game' };
  }
  if (candidate.kind !== 'in_game' || candidate.lobby === null || typeof candidate.lobby !== 'object') {
    return null;
  }
  const lobby = candidate.lobby as Record<string, unknown>;
  const insights = lobby.insights as Record<string, unknown> | null;
  if (
    typeof lobby.matchId !== 'string' ||
    !Array.isArray(lobby.participants) ||
    !lobby.participants.every(isLiveParticipantCard) ||
    insights === null ||
    typeof insights !== 'object' ||
    !Array.isArray(insights.offChampion) ||
    !Array.isArray(insights.oneTricks)
  ) {
    return null;
  }
  return { kind: 'in_game', lobby: candidate.lobby as unknown as LiveGameLobby };
}

/**
 * `GET /api/live-game`. Same contract as `lookupProfile`: never rejects, always
 * settles. `not_in_game` is a normal outcome, not an error (Requirement 1.2).
 */
export async function fetchLiveGame(
  riotId: RiotIdParts,
  options: LookupClientOptions = {},
): Promise<LiveGameOutcome> {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const baseUrl = options.baseUrl ?? apiBaseUrl;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const query = new URLSearchParams({ gameName: riotId.gameName, tagLine: riotId.tagLine });
    const url = `${baseUrl}/api/live-game?${query.toString()}`;

    let response: Response;
    try {
      response = await doFetch(url, { method: 'GET', signal: controller.signal });
    } catch {
      return { kind: 'error', error: synthesizedError(timedOut ? 'TIMEOUT' : 'NETWORK_ERROR') };
    }

    let parsed: unknown;
    let parseFailed = false;
    try {
      parsed = await response.json();
    } catch {
      parseFailed = true;
    }

    if (response.ok) {
      const narrowed = parseFailed ? null : readLiveGameResponse(parsed);
      return narrowed ?? { kind: 'error', error: synthesizedError('RIOT_UNAVAILABLE') };
    }

    return {
      kind: 'error',
      error: parseFailed
        ? synthesizedError(errorCodeForStatus(response.status))
        : readErrorPayload(parsed, response.status),
    };
  } finally {
    clearTimeout(timer);
  }
}
