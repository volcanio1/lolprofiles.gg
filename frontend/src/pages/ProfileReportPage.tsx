/**
 * Profile report page (`/profile?riotId=...`).
 *
 * Runs the Lookup_Session and renders exactly one of four states: loading, error,
 * report, or a prompt when the URL carries no Riot ID.
 *
 * Implements:
 *  - 9.6/9.7: the loading indicator appears on dispatch and is gone in every
 *    terminal state, because `useLookup` owns that lifecycle.
 *  - 9.1-9.5, 9.8, 9.9: error states, including the bounded retry and the
 *    rate-limit cooldown, via `ErrorNotice`.
 *  - 11.3, 11.4, 11.5, 6.x, 7.x, 8.5: the report itself, via `ProfileReportView`.
 *  - 12.1/12.2: attribution and the no-advertising default, via `RiotDataPage`.
 *  - lookup-pipeline-fixes Requirement 2.1/2.2: no region or platform query
 *    parameter — the Riot ID is the only input.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. THE URL IS THE SESSION'S INPUT, SO A CHANGED URL STARTS A NEW SESSION. The
 *    effect keys on the Riot ID query parameter, which means editing the address
 *    bar or navigating back behaves exactly like searching again — including
 *    resetting Requirement 9.3's retry budget, since it is genuinely a different
 *    lookup.
 *
 * 2. AN ABSENT RIOT ID IS A PROMPT, NOT AN ERROR. Landing on `/profile` with no
 *    parameters is a navigation accident, not a failed lookup, so it must not
 *    render a Requirement 9 error state — none of them describes it, and
 *    `VALIDATION_FAILED` would be a lie since nothing was submitted.
 *
 * 3. THE SEARCH FORM IS REPEATED HERE, PREFILLED. Requirement 9.1's field-specific
 *    feedback is only useful where the visitor actually is when they discover a
 *    mistake — most often looking at a "player not found" message. Prefilling
 *    from the URL means correcting a typo is one interaction, not a trip back to
 *    the search page.
 */

import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorNotice } from '../components/ErrorNotice';
import { LoadingIndicator } from '../components/LoadingIndicator';
import { ProfileReportView } from '../components/ProfileReportView';
import { SearchForm, type SearchSubmission } from '../components/SearchForm';
import { RiotDataPage } from '../compliance/RiotDataPage';
import { useLookup, type UseLookupOptions } from '../hooks/useLookup';

export interface ProfileReportPageProps {
  /** Injected in tests; production uses the real client, clock and scheduler. */
  lookupOptions?: UseLookupOptions;
}

export function ProfileReportPage({ lookupOptions }: ProfileReportPageProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams();

  const riotId = (searchParams.get('riotId') ?? '').trim();

  const { status, report, error, loading, canRetry, retriesRemaining, cooldownSecondsRemaining, start, retry } =
    useLookup(lookupOptions);

  // Decision 1.
  useEffect(() => {
    if (riotId.length === 0) {
      return;
    }
    start({ riotId });
    // `start` is stable; the query parameter is the real input.
  }, [riotId, start]);

  function handleResubmit(submission: SearchSubmission) {
    setSearchParams(new URLSearchParams({ riotId: submission.riotId }));
  }

  return (
    <RiotDataPage title="Profile report">
      {/*
        Decision 3. The `key` remounts the form whenever the URL changes, so its
        field always agrees with the report beside it. `SearchForm` seeds its own
        state from `initialRiotId`, which React only reads on mount — without the
        key, pressing Back would leave the form showing the previous Riot ID while
        the report showed a different one.
      */}
      <SearchForm key={riotId} onSubmit={handleResubmit} initialRiotId={riotId} busy={loading} />

      {/* Decision 2 */}
      {riotId.length === 0 ? (
        <p data-testid="no-riot-id-prompt" className="prompt">
          Enter a Riot ID above to see a profile report.
        </p>
      ) : null}

      {/* Requirement 9.6 */}
      {loading ? <LoadingIndicator /> : null}

      {/* Requirements 9.1-9.5, 9.8, 9.9 */}
      {status === 'error' && error !== undefined ? (
        <ErrorNotice
          error={error}
          canRetry={canRetry}
          retriesRemaining={retriesRemaining}
          cooldownSecondsRemaining={cooldownSecondsRemaining}
          onRetry={retry}
        />
      ) : null}

      {status === 'success' && report !== undefined ? <ProfileReportView report={report} /> : null}
    </RiotDataPage>
  );
}
