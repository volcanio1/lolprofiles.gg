/**
 * Riot ID Validator.
 *
 * Pure module: no I/O, no network, no cache, no environment access, no logging.
 *
 * Implements Requirements 1.2-1.5:
 *  - the raw value must contain exactly one `#`
 *  - both parts, after trimming leading/trailing whitespace, must be non-empty
 *  - the trimmed gameName must be at most MAX_GAME_NAME_LENGTH characters
 *  - the trimmed tagLine must be at most MAX_TAG_LINE_LENGTH characters
 *
 * Error precedence (deterministic, and mirrored by the tests):
 *   1. MISSING_HASH        - zero `#` characters
 *   2. MULTIPLE_HASH       - more than one `#` character
 *   3. EMPTY_PART          - either trimmed part is empty
 *   4. GAME_NAME_TOO_LONG  - trimmed gameName exceeds its maximum
 *   5. TAG_LINE_TOO_LONG   - trimmed tagLine exceeds its maximum
 *
 * Rationale: the hash-count checks must come first because the value cannot be
 * split into a gameName/tagLine pair at all until exactly one separator is
 * known to exist. EMPTY_PART precedes the length checks because an empty part
 * can never simultaneously be an over-length part, so ordering those two
 * relative to each other only matters for making the outcome total and
 * predictable. GAME_NAME_TOO_LONG precedes TAG_LINE_TOO_LONG so that a value
 * violating both length rules always reports the gameName violation.
 */

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

export interface RiotIdValidationResult {
  ok: boolean;
  riotId?: RiotIdParts;
  errorCode?: RiotIdErrorCode;
}

export function validateRiotId(raw: string): RiotIdValidationResult {
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
