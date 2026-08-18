/**
 * API layer — the client-facing error contract.
 *
 * PURE MODULE. No I/O, no clock, no logging: it maps a `LookupResult` error (or a
 * validation failure) onto an HTTP status and a JSON body. Keeping it pure and
 * separate from the route handlers is what lets Requirement 9's message content
 * be asserted directly, without an HTTP round trip.
 *
 * Implements the user-facing half of:
 *  - 9.1: a validation failure names the specific rule that was not met.
 *  - 9.2: not-found identifies the submitted gameName and tagLine.
 *  - 9.3: Riot unavailability is retriable, capped at `MAX_MANUAL_RETRIES`.
 *  - 9.4: a timeout says the lookup timed out.
 *  - 9.5: a rejected credential produces a GENERIC service-unavailable message
 *    with no credential detail of any kind.
 *  - 9.8: a rate limit carries a cooldown of at least
 *    `RATE_LIMIT_COOLDOWN_SECONDS` before a retry may be offered.
 *  - 9.9: a transport failure says a connection error occurred.
 *  - 5.5: an unsupported region or platform is rejected.
 *  - 3.6: a match-history failure says match history could not be retrieved.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. STATUS CODES ARE CHOSEN TO DESCRIBE THE UPSTREAM CONDITION, NOT TO MIRROR
 *    RIOT'S STATUS. In particular `AUTH_FAILURE` is **503, never 401 or 403**.
 *    Requirement 9.5 requires a generic "service unavailable" message that does
 *    not expose credential details, and forwarding 401/403 would tell any caller
 *    that the failure is an authentication problem on our side — a detail that is
 *    operationally sensitive and useless to the visitor, who cannot act on it.
 *    From the client's perspective the service genuinely is unavailable.
 *
 *    The rest: 400 for input we rejected before calling Riot, 404 for a player who
 *    does not exist, 429 for rate limiting so standard client tooling honors it,
 *    504 for our own 10s/15s budget expiring (a gateway timeout is exactly what
 *    that is), 502 for a transport failure where no HTTP response was received
 *    (a bad gateway, distinct from 503's "reachable but unwell"), and 503 for a
 *    Riot service that answered but could not serve us.
 *
 * 2. `PLAYER_NOT_FOUND` ECHOES THE RIOT ID; `UNSUPPORTED_REGION` DOES NOT ECHO
 *    THE OFFENDING VALUE. Requirement 9.2 explicitly requires identifying the
 *    submitted gameName and tagLine, and by the time that error is possible both
 *    have passed validation — so they are length-bounded, contain exactly one
 *    separator, and are safe to reflect. An unsupported region or platform, by
 *    contrast, is *arbitrary unvalidated input*, and reflecting it back buys the
 *    visitor nothing. Listing the supported values instead is both safer and more
 *    actionable, since it tells them what to pick.
 *
 * 3. THE RATE-LIMIT COOLDOWN IS A FIXED 5 SECONDS, NOT RIOT'S `Retry-After`.
 *    Requirement 9.8 asks for a cooldown of "at least 5 seconds" before the retry
 *    action is re-enabled. Riot's own `Retry-After` is already honored *inside*
 *    the Riot API Client's retry loop (Requirements 4.6/4.7) — by the time a
 *    `RATE_LIMITED` result reaches this layer, that wait has been served twice and
 *    the request abandoned. So this cooldown is an additional visitor-facing
 *    guard, not a substitute for Riot's, and the flat minimum satisfies it. This
 *    is also why `LookupResult` does not need to carry `retryAfterSeconds`.
 *
 * 4. `retriable` IS PASSED THROUGH FROM THE ORCHESTRATOR, NOT RECOMPUTED. The
 *    orchestrator already derives it from design.md's error table; deriving it a
 *    second time here would be a second source of truth that could disagree.
 */

import type { ErrorCode } from '../orchestrator';
import { SUPPORTED_REGIONS } from '../region';
import { MAX_GAME_NAME_LENGTH, MAX_TAG_LINE_LENGTH, type RiotIdErrorCode } from '../validator';

/** Requirement 9.3: the cap the client enforces on explicit retries per session. */
export const MAX_MANUAL_RETRIES = 3;

/** Requirement 9.8: minimum cooldown before a retry may be offered again. */
export const RATE_LIMIT_COOLDOWN_SECONDS = 5;

/** Which input field a validation failure belongs to, when it belongs to one. */
export type ValidationField = 'riotId' | 'gameName' | 'tagLine' | 'region' | 'platform' | 'puuid';

/**
 * Requirement 9.10 (Finding A). Names the region and platform that were actually
 * searched, because the whole point of this state is that the visitor's Riot ID was
 * right and their region was wrong — a message that does not say which region was
 * tried gives them nothing to correct.
 */
export function playerNotOnPlatformError(
  gameName: string,
  tagLine: string,
  region: string,
  platform: string,
): ApiErrorResponse {
  return {
    status: HTTP_STATUS_BY_ERROR_CODE.PLAYER_NOT_ON_PLATFORM,
    body: {
      error: {
        code: 'PLAYER_NOT_ON_PLATFORM',
        message:
          `${gameName}#${tagLine} exists, but has no League of Legends profile on ${platform.toUpperCase()} ` +
          `(${region}). Select the region where this player plays and search again.`,
        // Retrying the same region cannot succeed; the visitor must change it.
        retriable: false,
        gameName,
        tagLine,
        region,
        platform,
        field: 'region',
      },
    },
  };
}

export interface ApiErrorPayload {
  code: ErrorCode;
  message: string;
  /** Requirement 9.3/9.8/9.9: whether an explicit retry is worth offering. */
  retriable: boolean;
  /** Requirement 9.8, on `RATE_LIMITED` only. */
  retryAfterSeconds?: number;
  /** Requirement 9.3, on `RIOT_UNAVAILABLE` only. */
  maxRetries?: number;
  /** Requirements 9.2 / 9.10, on `PLAYER_NOT_FOUND` and `PLAYER_NOT_ON_PLATFORM`. */
  gameName?: string;
  tagLine?: string;
  /** Requirement 9.10: the region and platform that were actually searched. */
  region?: string;
  platform?: string;
  /** Requirement 9.1: the specific rule that was not met. */
  validationRule?: RiotIdErrorCode;
  /** Requirement 1.5 / 9.1: which field the visitor should correct. */
  field?: ValidationField;
}

export interface ApiErrorBody {
  error: ApiErrorPayload;
}

export interface ApiErrorResponse {
  status: number;
  body: ApiErrorBody;
}

/** Decision 1. Every member of `ErrorCode` is mapped, so the record is total. */
export const HTTP_STATUS_BY_ERROR_CODE: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNSUPPORTED_REGION: 400,
  PLAYER_NOT_FOUND: 404,
  // Requirement 9.10: not found ON THAT PLATFORM. A 404 like PLAYER_NOT_FOUND,
  // because the resource genuinely does not exist there, but a distinct code so the
  // visitor is told to change region rather than that Riot is broken.
  PLAYER_NOT_ON_PLATFORM: 404,
  RIOT_UNAVAILABLE: 503,
  TIMEOUT: 504,
  RATE_LIMITED: 429,
  AUTH_FAILURE: 503,
  NETWORK_ERROR: 502,
  MATCH_HISTORY_UNAVAILABLE: 503,
};

/**
 * Requirement 9.1: one message per validation rule, naming the constraint that
 * was violated rather than restating the whole format for every case.
 *
 * The two hash rules and the empty-part rule all point at the `gameName#tagLine`
 * format, which is what Requirements 1.3 and 1.4 ask for; the two length rules
 * name the specific field and its limit, which is what Requirement 1.5 asks for.
 */
export const VALIDATION_MESSAGES: Readonly<
  Record<RiotIdErrorCode, { message: string; field: ValidationField }>
> = {
  MISSING_HASH: {
    message: 'Enter a Riot ID in the format gameName#tagLine, for example Faker#KR1.',
    field: 'riotId',
  },
  MULTIPLE_HASH: {
    message: 'Enter a Riot ID in the format gameName#tagLine, using exactly one # character.',
    field: 'riotId',
  },
  EMPTY_PART: {
    message: 'Enter a Riot ID in the format gameName#tagLine, with both the game name and the tag line filled in.',
    field: 'riotId',
  },
  GAME_NAME_TOO_LONG: {
    message: `The game name must be at most ${String(MAX_GAME_NAME_LENGTH)} characters.`,
    field: 'gameName',
  },
  TAG_LINE_TOO_LONG: {
    message: `The tag line must be at most ${String(MAX_TAG_LINE_LENGTH)} characters.`,
    field: 'tagLine',
  },
};

/**
 * Static messages for the non-validation codes. `PLAYER_NOT_FOUND` is absent
 * because Requirement 9.2 requires interpolating the submitted Riot ID; use
 * `playerNotFoundError`.
 *
 * `AUTH_FAILURE`'s text is deliberately indistinguishable in kind from
 * `RIOT_UNAVAILABLE`'s (Requirement 9.5, decision 1): it names no credential, no
 * key, no token and no HTTP status, so a client cannot tell an expired key from
 * a Riot outage.
 */
export const MESSAGE_BY_ERROR_CODE: Readonly<
  Record<Exclude<ErrorCode, 'PLAYER_NOT_FOUND' | 'PLAYER_NOT_ON_PLATFORM'>, string>
> = {
  VALIDATION_FAILED: VALIDATION_MESSAGES.MISSING_HASH.message,
  UNSUPPORTED_REGION: `That region is not supported. Choose one of: ${SUPPORTED_REGIONS.join(', ')}.`,
  RIOT_UNAVAILABLE: "Riot's services are temporarily unavailable. Please try again in a moment.",
  TIMEOUT: 'The lookup timed out before Riot responded. Please try again.',
  RATE_LIMITED: `This lookup was rate-limited. Please wait ${String(RATE_LIMIT_COOLDOWN_SECONDS)} seconds and try again.`,
  AUTH_FAILURE: 'This service is temporarily unavailable. Please try again later.',
  NETWORK_ERROR: 'A connection error occurred while contacting Riot. Please check your connection and try again.',
  MATCH_HISTORY_UNAVAILABLE: 'Match history could not be retrieved for this player. Please try again in a moment.',
};

/** Requirement 9.1: a Riot ID that failed a specific validation rule. */
export function validationError(rule: RiotIdErrorCode): ApiErrorResponse {
  const { message, field } = VALIDATION_MESSAGES[rule];
  return {
    status: HTTP_STATUS_BY_ERROR_CODE.VALIDATION_FAILED,
    body: {
      error: {
        code: 'VALIDATION_FAILED',
        message,
        retriable: false, // Retrying the same input cannot succeed; the visitor must edit it.
        validationRule: rule,
        field,
      },
    },
  };
}

/**
 * A required field was absent or not a string. Distinct from `validationError`
 * because no `RiotIdErrorCode` describes "the field wasn't sent at all", and
 * claiming one would misreport which rule was broken (Requirement 9.1).
 */
export function missingFieldError(field: ValidationField, message: string): ApiErrorResponse {
  return {
    status: HTTP_STATUS_BY_ERROR_CODE.VALIDATION_FAILED,
    body: { error: { code: 'VALIDATION_FAILED', message, retriable: false, field } },
  };
}

/** Requirement 5.5. Lists the supported values rather than echoing input (decision 2). */
export function unsupportedRegionError(field: 'region' | 'platform'): ApiErrorResponse {
  const message =
    field === 'region'
      ? MESSAGE_BY_ERROR_CODE.UNSUPPORTED_REGION
      : 'That platform is not supported. Leave it unset to use the default for the selected region.';
  return {
    status: HTTP_STATUS_BY_ERROR_CODE.UNSUPPORTED_REGION,
    body: { error: { code: 'UNSUPPORTED_REGION', message, retriable: false, field } },
  };
}

/** Requirement 9.2: identifies the submitted gameName and tagLine (decision 2). */
export function playerNotFoundError(gameName: string, tagLine: string): ApiErrorResponse {
  return {
    status: HTTP_STATUS_BY_ERROR_CODE.PLAYER_NOT_FOUND,
    body: {
      error: {
        code: 'PLAYER_NOT_FOUND',
        message: `No player was found for the Riot ID ${gameName}#${tagLine}. Check the spelling and the region.`,
        retriable: false,
        gameName,
        tagLine,
      },
    },
  };
}

/**
 * Maps an orchestrator error onto its HTTP response. `retriable` is passed
 * through rather than recomputed (decision 4).
 */
export function apiErrorFor(code: ErrorCode, retriable: boolean): ApiErrorResponse {
  if (code === 'PLAYER_NOT_FOUND') {
    // Unreachable via `runLookup`, which reports a missing player as
    // `{ kind: 'not_found' }` rather than as an error code. Kept total so this
    // function cannot be called into an undefined message.
    return playerNotFoundError('', '');
  }
  if (code === 'PLAYER_NOT_ON_PLATFORM') {
    // The route calls `playerNotOnPlatformError` directly, because only it knows
    // which region and platform were searched. Kept total for the same reason.
    return playerNotOnPlatformError('', '', '', '');
  }

  const payload: ApiErrorPayload = {
    code,
    message: MESSAGE_BY_ERROR_CODE[code],
    retriable,
  };

  if (code === 'RATE_LIMITED') {
    payload.retryAfterSeconds = RATE_LIMIT_COOLDOWN_SECONDS; // Requirement 9.8
  }
  if (code === 'RIOT_UNAVAILABLE' || code === 'MATCH_HISTORY_UNAVAILABLE') {
    payload.maxRetries = MAX_MANUAL_RETRIES; // Requirement 9.3
  }

  return { status: HTTP_STATUS_BY_ERROR_CODE[code], body: { error: payload } };
}

/**
 * A defect, not a lookup outcome: something threw where the contract says it
 * should not. The body is deliberately opaque — an internal failure must not
 * describe itself to a client, for the same reason `AUTH_FAILURE` does not.
 */
export function internalError(): ApiErrorResponse {
  return {
    status: 500,
    body: {
      error: {
        code: 'RIOT_UNAVAILABLE',
        message: 'Something went wrong handling this request. Please try again.',
        retriable: true,
        maxRetries: MAX_MANUAL_RETRIES,
      },
    },
  };
}

/** A request body that was not parseable JSON, or was not a JSON object. */
export function malformedRequestError(): ApiErrorResponse {
  return {
    status: 400,
    body: {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The request body must be a JSON object.',
        retriable: false,
      },
    },
  };
}
