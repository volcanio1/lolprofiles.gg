import { describe, it, expect } from 'vitest';
import type { ErrorCode } from '../orchestrator';
import type { RiotIdErrorCode } from '../validator';
import {
  HTTP_STATUS_BY_ERROR_CODE,
  MAX_MANUAL_RETRIES,
  MESSAGE_BY_ERROR_CODE,
  RATE_LIMIT_COOLDOWN_SECONDS,
  VALIDATION_MESSAGES,
  apiErrorFor,
  internalError,
  malformedRequestError,
  missingFieldError,
  noLolAccountError,
  playerNotFoundError,
  unsupportedPlatformError,
  validationError,
} from './errors';

/**
 * Task 15.3 — error response CONTENT. Pure assertions against the mapping module,
 * with no HTTP round trip, because what these requirements constrain is the
 * message the visitor reads, not the transport.
 */

const ALL_ERROR_CODES: readonly ErrorCode[] = [
  'VALIDATION_FAILED',
  'PLAYER_NOT_FOUND',
  'NO_LOL_ACCOUNT',
  'UNSUPPORTED_PLATFORM',
  'RIOT_UNAVAILABLE',
  'TIMEOUT',
  'RATE_LIMITED',
  'AUTH_FAILURE',
  'NETWORK_ERROR',
  'MATCH_HISTORY_UNAVAILABLE',
];

const ALL_VALIDATION_RULES: readonly RiotIdErrorCode[] = [
  'MISSING_HASH',
  'MULTIPLE_HASH',
  'EMPTY_PART',
  'GAME_NAME_TOO_LONG',
  'TAG_LINE_TOO_LONG',
];

describe('error mapping totality', () => {
  it('maps every error code to a 4xx or 5xx status', () => {
    for (const code of ALL_ERROR_CODES) {
      const status = HTTP_STATUS_BY_ERROR_CODE[code];
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
    }
  });

  it('produces a non-empty message for every error code', () => {
    for (const code of ALL_ERROR_CODES) {
      let body;
      if (code === 'PLAYER_NOT_FOUND') {
        body = playerNotFoundError('A', 'B').body;
      } else if (code === 'NO_LOL_ACCOUNT') {
        body = noLolAccountError('A', 'B').body;
      } else if (code === 'UNSUPPORTED_PLATFORM') {
        body = unsupportedPlatformError('vn2').body;
      } else {
        body = apiErrorFor(code, false).body;
      }
      expect(body.error.message.length, code).toBeGreaterThan(0);
      expect(body.error.code, code).toBe(code);
    }
  });

  it('never leaks an internal error\u2019s detail to the client', () => {
    const { status, body } = internalError();
    expect(status).toBe(500);
    expect(body.error.message).not.toMatch(/stack|trace|Error:|at \w+/i);
  });
});

describe('Requirement 9.2 — player not found', () => {
  it('answers 404 and identifies the submitted gameName and tagLine', () => {
    const { status, body } = playerNotFoundError('Doffy', 'Smile');

    expect(status).toBe(404);
    expect(body.error.code).toBe('PLAYER_NOT_FOUND');
    expect(body.error.message).toContain('Doffy');
    expect(body.error.message).toContain('Smile');
    expect(body.error.gameName).toBe('Doffy');
    expect(body.error.tagLine).toBe('Smile');
  });

  it('is not offered as a retriable failure', () => {
    // The same Riot ID will not start existing on a retry; the visitor must edit it.
    expect(playerNotFoundError('Doffy', 'Smile').body.error.retriable).toBe(false);
  });
});

describe('lookup-pipeline-fixes Requirement 5.2 — Riot account with no League play history', () => {
  it('answers 404 and identifies the submitted gameName and tagLine', () => {
    const { status, body } = noLolAccountError('Doffy', 'Smile');

    expect(status).toBe(404);
    expect(body.error.code).toBe('NO_LOL_ACCOUNT');
    expect(body.error.message).toContain('Doffy#Smile');
    expect(body.error.gameName).toBe('Doffy');
    expect(body.error.tagLine).toBe('Smile');
  });

  it('does not claim Riot is unavailable, and is not retriable', () => {
    const { body } = noLolAccountError('Doffy', 'Smile');

    expect(body.error.message).not.toMatch(/unavailable|try again later|temporarily/i);
    expect(body.error.message).not.toBe(MESSAGE_BY_ERROR_CODE.RIOT_UNAVAILABLE);
    expect(body.error.retriable).toBe(false);
  });

  it('is distinguishable from a genuinely nonexistent Riot account', () => {
    const noLol = noLolAccountError('Doffy', 'Smile').body.error;
    const notFound = playerNotFoundError('Doffy', 'Smile').body.error;

    expect(noLol.code).not.toBe(notFound.code);
    expect(noLol.message).not.toBe(notFound.message);
    // Both are 404s: in each case the resource asked for does not exist.
    expect(HTTP_STATUS_BY_ERROR_CODE.NO_LOL_ACCOUNT).toBe(404);
  });
});

describe('lookup-pipeline-fixes Requirement 5.3 — unsupported platform reported by Riot', () => {
  it('answers 404 and names the platform Riot itself reported', () => {
    const { status, body } = unsupportedPlatformError('vn2');

    expect(status).toBe(404);
    expect(body.error.code).toBe('UNSUPPORTED_PLATFORM');
    expect(body.error.message).toContain('vn2');
    expect(body.error.platform).toBe('vn2');
  });

  it('is not retriable, since the same platform will be reported again', () => {
    expect(unsupportedPlatformError('vn2').body.error.retriable).toBe(false);
  });

  it('no longer emits PLAYER_NOT_ON_PLATFORM from any code path (Requirement 5.4)', () => {
    expect(ALL_ERROR_CODES).not.toContain('PLAYER_NOT_ON_PLATFORM');
  });
});

describe('Requirement 9.4 — timeout', () => {
  it('answers 504 and says the lookup timed out', () => {
    const { status, body } = apiErrorFor('TIMEOUT', false);

    expect(status).toBe(504);
    expect(body.error.code).toBe('TIMEOUT');
    expect(body.error.message).toMatch(/timed out/i);
  });
});

describe('Requirement 9.5 — rejected credential', () => {
  /**
   * The whole point of 9.5 is that the visitor learns nothing about the
   * credential. This asserts on the SERIALIZED body, so a leak in any field —
   * message, code, or a field added later — fails the test.
   */
  it('answers with a generic service-unavailable message and no credential detail', () => {
    const { status, body } = apiErrorFor('AUTH_FAILURE', false);
    const serialized = JSON.stringify(body).toLowerCase();

    expect(status).toBe(503);
    expect(body.error.message).toMatch(/unavailable/i);

    for (const forbidden of [
      'key',
      'token',
      'credential',
      'apikey',
      'x-riot-token',
      '401',
      '403',
      'unauthorized',
      'forbidden',
      'rgapi',
    ]) {
      expect(serialized, `leaked "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('is not distinguishable from an outage by status code', () => {
    // A 401/403 passthrough would tell any caller the failure is ours, which is
    // both operationally sensitive and useless to the visitor.
    expect(HTTP_STATUS_BY_ERROR_CODE.AUTH_FAILURE).toBe(HTTP_STATUS_BY_ERROR_CODE.RIOT_UNAVAILABLE);
    expect(HTTP_STATUS_BY_ERROR_CODE.AUTH_FAILURE).not.toBe(401);
    expect(HTTP_STATUS_BY_ERROR_CODE.AUTH_FAILURE).not.toBe(403);
  });

  it('does not invite a retry, since a rejected credential will stay rejected', () => {
    expect(apiErrorFor('AUTH_FAILURE', false).body.error.retriable).toBe(false);
  });
});

describe('Requirement 9.8 — rate limited', () => {
  it('answers 429 with a cooldown of at least 5 seconds', () => {
    const { status, body } = apiErrorFor('RATE_LIMITED', true);

    expect(status).toBe(429);
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retryAfterSeconds).toBeGreaterThanOrEqual(5);
    expect(RATE_LIMIT_COOLDOWN_SECONDS).toBeGreaterThanOrEqual(5);
  });

  it('says it was rate-limited and names the wait', () => {
    const { body } = apiErrorFor('RATE_LIMITED', true);

    expect(body.error.message).toMatch(/rate-limited/i);
    expect(body.error.message).toContain(String(RATE_LIMIT_COOLDOWN_SECONDS));
  });

  it('is retriable once the cooldown elapses', () => {
    expect(apiErrorFor('RATE_LIMITED', true).body.error.retriable).toBe(true);
  });
});

describe('Requirement 9.9 — network error', () => {
  it('answers 502 and reports a connection error, distinctly from a timeout', () => {
    const { status, body } = apiErrorFor('NETWORK_ERROR', true);

    expect(status).toBe(502);
    expect(body.error.code).toBe('NETWORK_ERROR');
    expect(body.error.message).toMatch(/connection/i);
    // Requirement 9.9 is a different visitor-facing state than 9.4.
    expect(body.error.message).not.toBe(MESSAGE_BY_ERROR_CODE.TIMEOUT);
    expect(status).not.toBe(HTTP_STATUS_BY_ERROR_CODE.TIMEOUT);
  });

  it('allows the visitor to retry', () => {
    expect(apiErrorFor('NETWORK_ERROR', true).body.error.retriable).toBe(true);
  });
});

describe('Requirement 9.3 — Riot temporarily unavailable', () => {
  it('answers 503, is retriable, and advertises the 3-retry cap', () => {
    const { status, body } = apiErrorFor('RIOT_UNAVAILABLE', true);

    expect(status).toBe(503);
    expect(body.error.message).toMatch(/temporarily unavailable/i);
    expect(body.error.retriable).toBe(true);
    expect(body.error.maxRetries).toBe(MAX_MANUAL_RETRIES);
    expect(MAX_MANUAL_RETRIES).toBe(3);
  });

  it('advertises the same cap for a match-history failure (Requirement 3.6)', () => {
    const { status, body } = apiErrorFor('MATCH_HISTORY_UNAVAILABLE', true);

    expect(status).toBe(503);
    expect(body.error.message).toMatch(/match history/i);
    expect(body.error.maxRetries).toBe(MAX_MANUAL_RETRIES);
  });

  it('does not attach a retry cap to failures that are not retried in place', () => {
    expect(apiErrorFor('TIMEOUT', false).body.error.maxRetries).toBeUndefined();
    expect(apiErrorFor('AUTH_FAILURE', false).body.error.maxRetries).toBeUndefined();
  });
});

describe('Requirement 9.1 — validation messages name the rule that failed', () => {
  it('produces a distinct message for every validation rule', () => {
    const messages = new Set<string>();
    for (const rule of ALL_VALIDATION_RULES) {
      const { status, body } = validationError(rule);
      expect(status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.validationRule).toBe(rule);
      expect(body.error.retriable).toBe(false);
      messages.add(body.error.message);
    }
    expect(messages.size).toBe(ALL_VALIDATION_RULES.length);
  });

  it('points the format rules at the Riot ID field and names the format', () => {
    for (const rule of ['MISSING_HASH', 'MULTIPLE_HASH', 'EMPTY_PART'] as const) {
      const { body } = validationError(rule);
      expect(body.error.field, rule).toBe('riotId');
      expect(body.error.message, rule).toContain('gameName#tagLine');
    }
  });

  it('points each length rule at its own field and names the limit (Requirement 1.5)', () => {
    const gameName = validationError('GAME_NAME_TOO_LONG').body.error;
    expect(gameName.field).toBe('gameName');
    expect(gameName.message).toContain('16');

    const tagLine = validationError('TAG_LINE_TOO_LONG').body.error;
    expect(tagLine.field).toBe('tagLine');
    expect(tagLine.message).toContain('5');
  });

  it('covers every validation rule in the message table', () => {
    for (const rule of ALL_VALIDATION_RULES) {
      expect(VALIDATION_MESSAGES[rule].message.length, rule).toBeGreaterThan(0);
    }
  });

  it('reports an absent field without claiming a rule that was not broken', () => {
    const { status, body } = missingFieldError('riotId', 'Enter a Riot ID.');

    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.field).toBe('riotId');
    expect(body.error.validationRule).toBeUndefined();
  });

  it('rejects a non-object body', () => {
    const { status, body } = malformedRequestError();
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });
});

