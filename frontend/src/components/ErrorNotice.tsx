/**
 * Error state display for a failed Lookup_Session.
 *
 * Implements the visitor-facing half of Requirement 9:
 *  - 9.1 validation, 9.2 not found, 9.3 Riot unavailable, 9.4 timeout,
 *    9.5 auth failure (generic), 9.8 rate limited, 9.9 network error — each gets
 *    its own message, taken from the backend, plus a heading that distinguishes the
 *    states from one another.
 *  - 9.3: the retry action is offered only while retries remain, capped at 3.
 *  - 9.8: while a rate-limit cooldown is active the retry action is DISABLED and
 *    the remaining wait is shown, so the visitor understands why they are waiting.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. THE MESSAGE COMES FROM THE BACKEND; THE HEADING IS CHOSEN HERE. The backend
 *    owns message content because Requirements 9.2/9.4/9.5/9.8/9.9 constrain it and
 *    it is asserted there; duplicating the strings would create a second source of
 *    truth that drifts. The heading is presentation, so it lives here — and it is
 *    what makes the states visually distinct, which is the part a shared message
 *    body cannot do.
 *
 * 2. `AUTH_FAILURE` GETS THE SAME HEADING AS `RIOT_UNAVAILABLE`. Requirement 9.5
 *    requires a generic "service unavailable" presentation with no credential
 *    detail. A distinct heading such as "Authentication problem" would leak exactly
 *    what the backend deliberately withholds by answering 503 rather than 401.
 *
 * 3. THE RETRY BUTTON IS RENDERED-BUT-DISABLED DURING A COOLDOWN, not removed.
 *    Requirement 9.8 says to disable the action for the cooldown period, and a
 *    button that vanishes and reappears is both harder to understand and worse for
 *    assistive technology than one that stays put and explains itself.
 *
 * 4. `role="alert"` ON THE CONTAINER. A failed lookup is the answer to something
 *    the visitor explicitly asked for, so it warrants an assertive announcement —
 *    unlike the loading state, which is polite.
 */

import type { ApiErrorPayload, ErrorCode } from '../api/types';

export interface ErrorNoticeProps {
  error: ApiErrorPayload;
  /** Requirements 9.3/9.8: whether a retry may be initiated right now. */
  canRetry: boolean;
  retriesRemaining: number;
  cooldownSecondsRemaining: number;
  onRetry: () => void;
}

/** Decision 1: headings are presentation and belong to the frontend. */
const HEADINGS: Readonly<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: 'Check the Riot ID',
  PLAYER_NOT_FOUND: 'Player not found',
  // lookup-pipeline-fixes Requirement 5.2: distinct from PLAYER_NOT_FOUND — the
  // Riot account DOES exist, it has simply never played League.
  NO_LOL_ACCOUNT: 'No League of Legends history',
  // Requirement 5.3: the Region Resolver named a platform this build doesn't
  // recognize yet — not a Riot outage and not the visitor's mistake.
  UNSUPPORTED_PLATFORM: 'Region not supported yet',
  RIOT_UNAVAILABLE: 'Service temporarily unavailable',
  TIMEOUT: 'The lookup timed out',
  RATE_LIMITED: 'Too many lookups right now',
  // Decision 2: deliberately identical to RIOT_UNAVAILABLE.
  AUTH_FAILURE: 'Service temporarily unavailable',
  NETWORK_ERROR: 'Connection problem',
  MATCH_HISTORY_UNAVAILABLE: 'Match history unavailable',
};

export function ErrorNotice({
  error,
  canRetry,
  retriesRemaining,
  cooldownSecondsRemaining,
  onRetry,
}: ErrorNoticeProps) {
  const cooldownActive = cooldownSecondsRemaining > 0;
  // Requirement 9.3: only retriable failures with budget left offer the action.
  const showRetry = error.retriable && retriesRemaining > 0;

  return (
    <section role="alert" aria-labelledby="lookup-error-heading" data-testid="error-notice" className="error-notice">
      <h2 id="lookup-error-heading" className="error-heading">
        {HEADINGS[error.code] ?? 'Something went wrong'}
      </h2>

      {/* Decision 1: the backend's message, which the requirements constrain. */}
      <p data-testid="error-message" className="error-body">
        {error.message}
      </p>

      {showRetry ? (
        <div className="error-actions">
          <button
            type="button"
            // Decision 3 / Requirement 9.8.
            disabled={!canRetry}
            onClick={onRetry}
            data-testid="retry-button"
            className="btn btn-ghost"
          >
            Try again
          </button>
          {cooldownActive ? (
            <p data-testid="cooldown-notice" className="error-meta">
              You can try again in {cooldownSecondsRemaining} second
              {cooldownSecondsRemaining === 1 ? '' : 's'}.
            </p>
          ) : null}
          {/* Requirement 9.3's cap, stated so the visitor is not surprised when it runs out. */}
          <p data-testid="retries-remaining" className="error-meta">
            {retriesRemaining} retr{retriesRemaining === 1 ? 'y' : 'ies'} remaining.
          </p>
        </div>
      ) : null}

      {error.retriable && retriesRemaining === 0 ? (
        <p data-testid="retries-exhausted" className="error-meta">
          You have used all available retries for this lookup. Start a new search to try again.
        </p>
      ) : null}
    </section>
  );
}
