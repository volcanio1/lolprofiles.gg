/**
 * Riot ID validation for inline, pre-submission feedback.
 *
 * PURE MODULE. No I/O, no React, no network.
 *
 * Implements Requirements 1.2-1.5 and the client half of 9.1: exactly one `#`,
 * both parts non-empty after trimming, gameName at most 16 characters, tagLine at
 * most 5, with a message naming the specific rule that failed.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DUPLICATES THE BACKEND VALIDATOR
 * ---------------------------------------------------------------------------
 *
 * `backend/src/validator` already implements exactly these rules and remains
 * AUTHORITATIVE — it rejects anything this module lets through, so a divergence
 * can cost a wasted round trip but can never admit an invalid lookup. The
 * duplication exists because Requirements 1.3-1.5 require the submission to be
 * rejected and a message displayed, which means the check has to run before the
 * request leaves the browser, and the two npm workspaces share no code.
 *
 * The alternative — a shared workspace package — would remove the drift risk but
 * changes both build configurations, and the task plan does not call for it. The
 * mitigation actually used is that this module's limits are asserted against the
 * literal numbers from Requirement 1.5 in its own tests, so a silent drift in
 * either copy fails a test rather than reaching a visitor. Recorded as an open
 * item in the implementation log.
 *
 * The error codes deliberately match the backend's `RiotIdErrorCode` names, so a
 * `validationRule` echoed back in a 400 response can be rendered with the same
 * message table (see `messageForRiotIdError`).
 */

/** Requirement 1.5. */
export const MAX_GAME_NAME_LENGTH = 16;
export const MAX_TAG_LINE_LENGTH = 5;

export type RiotIdErrorCode =
  | 'MISSING_HASH'
  | 'MULTIPLE_HASH'
  | 'EMPTY_PART'
  | 'GAME_NAME_TOO_LONG'
  | 'TAG_LINE_TOO_LONG';

export interface RiotIdParts {
  gameName: string;
  tagLine: string;
}

export type RiotIdValidation =
  | { ok: true; riotId: RiotIdParts }
  | { ok: false; errorCode: RiotIdErrorCode };

/**
 * Requirements 1.2-1.5. Precedence matches the backend validator exactly:
 * hash count first (the value cannot be split at all until one separator is
 * known to exist), then emptiness, then gameName length, then tagLine length.
 */
export function validateRiotId(raw: string): RiotIdValidation {
  const parts = raw.split('#');
  const hashCount = parts.length - 1;

  if (hashCount === 0) {
    return { ok: false, errorCode: 'MISSING_HASH' };
  }
  if (hashCount > 1) {
    return { ok: false, errorCode: 'MULTIPLE_HASH' };
  }

  const gameName = parts[0].trim();
  const tagLine = parts[1].trim();

  if (gameName.length === 0 || tagLine.length === 0) {
    return { ok: false, errorCode: 'EMPTY_PART' };
  }
  if (gameName.length > MAX_GAME_NAME_LENGTH) {
    return { ok: false, errorCode: 'GAME_NAME_TOO_LONG' };
  }
  if (tagLine.length > MAX_TAG_LINE_LENGTH) {
    return { ok: false, errorCode: 'TAG_LINE_TOO_LONG' };
  }

  return { ok: true, riotId: { gameName, tagLine } };
}

/** Which input the visitor should correct, for `aria-describedby` targeting. */
export type RiotIdErrorField = 'riotId' | 'gameName' | 'tagLine';

export interface RiotIdErrorDisplay {
  message: string;
  field: RiotIdErrorField;
}

/**
 * Requirement 9.1: a message identifying the rule that was not met. The three
 * structural failures point at the format (Requirements 1.3/1.4); the two length
 * failures name the field and its limit (Requirement 1.5).
 */
export const RIOT_ID_ERROR_DISPLAY: Readonly<Record<RiotIdErrorCode, RiotIdErrorDisplay>> = {
  MISSING_HASH: {
    message: 'Enter a Riot ID in the format gameName#tagLine, for example Faker#KR1.',
    field: 'riotId',
  },
  MULTIPLE_HASH: {
    message: 'Enter a Riot ID in the format gameName#tagLine, using exactly one # character.',
    field: 'riotId',
  },
  EMPTY_PART: {
    message:
      'Enter a Riot ID in the format gameName#tagLine, with both the game name and the tag line filled in.',
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

/** Falls back to the format message for an unrecognized code from the backend. */
export function messageForRiotIdError(code: string | undefined): string {
  if (code !== undefined && Object.prototype.hasOwnProperty.call(RIOT_ID_ERROR_DISPLAY, code)) {
    return RIOT_ID_ERROR_DISPLAY[code as RiotIdErrorCode].message;
  }
  return RIOT_ID_ERROR_DISPLAY.MISSING_HASH.message;
}
