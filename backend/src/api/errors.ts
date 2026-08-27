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
 *  - lookup-pipeline-fixes 5.2: a Riot account with no League play history gets
 *    its own message (`NO_LOL_ACCOUNT`), distinct from "not found".
 *  - lookup-pipeline-fixes 5.3: a platform Riot reports that this build doesn't
 *    recognize gets its own message (`UNSUPPORTED_PLATFORM`), naming it.
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
 * 2. WHETHER AN ERROR ECHOES ITS OFFENDING VALUE DEPENDS ON WHO SUPPLIED IT.
 *    `PLAYER_NOT_FOUND` and `NO_LOL_ACCOUNT` echo the submitted gameName/tagLine
 *    because Requirement 9.2/5.2 require it, and by the time either is possible
 *    both have passed validation — length-bounded, exactly one separator, safe
 *    to reflect. `UNSUPPORTED_PLATFORM` also echoes its value (the platform),
 *    but for the opposite reason: that string came from RIOT's own response,
 *    not from the visitor, so there is no untrusted-input concern and naming it
 *    is simply informative. (The formerly-existing `UNSUPPORTED_REGION`, which
 *    validated arbitrary visitor-supplied text and deliberately did NOT echo
 *    it, no longer exists — there is no region field left to validate.)
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
import { MAX_GAME_NAME_LENGTH, MAX_TAG_LINE_LENGTH, type RiotIdErrorCode } from '../validator';

/** Requirement 9.3: the cap the client enforces on explicit retries per session. */
export const MAX_MANUAL_RETRIES = 3;

/** Requirement 9.8: minimum cooldown before a retry may be offered again. */
export const RATE_LIMIT_COOLDOWN_SECONDS = 5;

/** Which input field a validation failure belongs to, when it belongs to one. */
export type ValidationField = 'riotId' | 'gameName' | 'tagLine' | 'platform' | 'puuid' | 'region';

/**
 * lookup-pipeline-fixes Requirement 5.2. Distinct from `playerNotFoundError`:
 * the Riot account genuinely exists (Account-V1 resolved it), it simply has no
 * League of Legends region on record, which is a different, more precise fact
 * than "not found" and deserves its own message rather than being folded into
 * one generic 404.
 */
export function noLolAccountError(gameName: string, tagLine: string): ApiErrorResponse {
  return {
    status: HTTP_STATUS_BY_ERROR_CODE.NO_LOL_ACCOUNT,
    body: {
      error: {
        code: 'NO_LOL_ACCOUNT',
        message: `${gameName}#${tagLine} is a Riot account, but it has no League of Legends play history.`,
        retriable: false,
        gameName,
        tagLine,
      },
    },
  };
}

/**
 * lookup-pipeline-fixes Requirement 5's `unsupported_platform` outcome. Unlike
 * the removed `unsupportedRegionError` (decision 2), this DOES name the
 * offending platform: it came from Riot itself, not from arbitrary visitor
 * input, so echoing it is informative rather than reflecting untrusted text.
 */
export function unsupportedPlatformError(platform: string): ApiErrorResponse {
  return {
    status: HTTP_STATUS_BY_ERROR_CODE.UNSUPPORTED_PLATFORM,
    body: {
      error: {
        code: 'UNSUPPORTED_PLATFORM',
        message: `This player's League of Legends region ("${platform}") is not one this site supports yet.`,
        retriable: false,
        platform,
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
  /** Requirements 9.2 / 5.2, on `PLAYER_NOT_FOUND` and `NO_LOL_ACCOUNT`. */
  gameName?: string;
  tagLine?: string;
  /** lookup-pipeline-fixes Requirement 5: the platform Riot itself reported, on `UNSUPPORTED_PLATFORM`. */
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
  PLAYER_NOT_FOUND: 404,
  // lookup-pipeline-fixes Requirement 5.2: the Riot account exists but has no
  // League data — same "the resource isn't there" shape as PLAYER_NOT_FOUND,
  // but a distinct code so the visitor isn't told to recheck their spelling.
  NO_LOL_ACCOUNT: 404,
  // Requirement 5.3: Riot named a platform this build doesn't recognize. Not the
  // visitor's fault and not actionable by retrying, but also not a Riot outage.
  UNSUPPORTED_PLATFORM: 404,
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
  Record<Exclude<ErrorCode, 'PLAYER_NOT_FOUND' | 'NO_LOL_ACCOUNT' | 'UNSUPPORTED_PLATFORM'>, string>
> = {
  VALIDATION_FAILED: VALIDATION_MESSAGES.MISSING_HASH.message,
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

/**
 * lookup-pipeline-fixes Requirement 2.1: `region` and `platform` are no longer
 * part of the request contract at all, now that the platform is discovered by
 * the Region Resolver. Rejecting them outright — rather than silently ignoring
 * them, which is what a body-shape-tolerant parser would do by default — means
 * a caller still sending either field (an old frontend build, a stale API
 * integration) gets a clear signal that its request no longer does what it
 * used to, instead of an unexplained behavior change.
 */
export function unknownFieldError(field: 'region' | 'platform'): ApiErrorResponse {
  return {
    status: HTTP_STATUS_BY_ERROR_CODE.VALIDATION_FAILED,
    body: {
      error: {
        code: 'VALIDATION_FAILED',
        message: `'${field}' is no longer accepted — the platform is now determined automatically from the Riot ID.`,
        retriable: false,
        field,
      },
    },
  };
}

/** Requirement 9.2: identifies the submitted gameName and tagLine (decision 2). */
export function playerNotFoundError(gameName: string, tagLine: string): ApiErrorResponse {
  return {
    status: HTTP_STATUS_BY_ERROR_CODE.PLAYER_NOT_FOUND,
    body: {
      error: {
        code: 'PLAYER_NOT_FOUND',
        // lookup-pipeline-fixes: no longer "and the region" — there is no region
        // for the visitor to have picked wrong anymore (Requirement 1).
        message: `No player was found for the Riot ID ${gameName}#${tagLine}. Check the spelling.`,
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
  if (code === 'NO_LOL_ACCOUNT') {
    // The route calls `noLolAccountError` directly, because only it knows the
    // gameName/tagLine that were searched. Kept total for the same reason.
    return noLolAccountError('', '');
  }
  if (code === 'UNSUPPORTED_PLATFORM') {
    // The route calls `unsupportedPlatformError` directly, because only it
    // knows which platform Riot named. Kept total for the same reason.
    return unsupportedPlatformError('');
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
