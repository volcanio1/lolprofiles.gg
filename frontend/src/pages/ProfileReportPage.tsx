/**
 * Profile report page (`/profile?riotId=...&region=...&platform=...`).
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
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. THE URL IS THE SESSION'S INPUT, SO A CHANGED URL STARTS A NEW SESSION. The
 *    effect keys on the three query parameters, which means editing the address bar
 *    or navigating back behaves exactly like searching again — including resetting
 *    Requirement 9.3's retry budget, since it is genuinely a different lookup.
 *
 * 2. THE REGION FROM THE URL IS NARROWED, NOT TRUSTED. `regionFromParam` falls back
 *    to Requirement 1.6's default rather than forwarding an arbitrary string, so a
 *    hand-edited URL cannot make the page issue a request the backend will reject
 *    under Requirement 5.5. The backend still validates, so this is convenience
 *    rather than a security boundary.
 *
 * 3. AN ABSENT RIOT ID IS A PROMPT, NOT AN ERROR. Landing on `/profile` with no
 *    parameters is a navigation accident, not a failed lookup, so it must not
 *    render a Requirement 9 error state — none of them describes it, and
 *    `VALIDATION_FAILED` would be a lie since nothing was submitted.
 *
 * 4. THE SEARCH FORM IS REPEATED HERE, PREFILLED. Requirement 9.1's field-specific
 *    feedback and Requirement 1.7's selector are only useful where the visitor
 *    actually is when they discover a mistake — most often looking at a
 *    "player not found" message. Prefilling from the URL means correcting a region
 *    is one interaction, not a trip back to the search page. This is also what makes
 *    Finding A (a correct Riot ID on the wrong region) recoverable in practice.
 */

import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorNotice } from '../components/ErrorNotice';
import { LoadingIndicator } from '../components/LoadingIndicator';
import { ProfileReportView } from '../components/ProfileReportView';
import { SearchForm, type SearchSubmission } from '../components/SearchForm';
import { RiotDataPage } from '../compliance/RiotDataPage';
import { regionFromParam, type RegionalRoutingValue } from '../domain/regions';
import { useLookup, type UseLookupOptions } from '../hooks/useLookup';

export interface ProfileReportPageProps {
  /** Injected in tests; production uses the real client, clock and scheduler. */
  lookupOptions?: UseLookupOptions;
}

export function ProfileReportPage({ lookupOptions }: ProfileReportPageProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams();

  const riotId = (searchParams.get('riotId') ?? '').trim();
  // Decision 2.
  const region: RegionalRoutingValue = regionFromParam(searchParams.get('region'));
  const platform = (searchParams.get('platform') ?? '').trim();

  const { status, report, error, loading, canRetry, retriesRemaining, cooldownSecondsRemaining, start, retry } =
    useLookup(lookupOptions);

  // Decision 1.
  useEffect(() => {
    if (riotId.length === 0) {
      return;
    }
    start({ riotId, region, platform: platform.length > 0 ? platform : undefined });
    // `start` is stable; the query parameters are the real inputs.
  }, [riotId, region, platform, start]);

  function handleResubmit(submission: SearchSubmission) {
    const next = new URLSearchParams({ riotId: submission.riotId, region: submission.region });
    if (submission.platform !== undefined && submission.platform.length > 0) {
      next.set('platform', submission.platform);
    }
    setSearchParams(next);
  }

  return (
    <RiotDataPage title="Profile report">
      {/*
        Decision 4. The `key` remounts the form whenever the URL changes, so its
        fields always agree with the report beside them. `SearchForm` seeds its own
        state from the `initial*` props, which React only reads on mount — without
        the key, pressing Back would leave the form showing the previous region
        while the report showed a different one.
      */}
      <SearchForm
        key={`${riotId}|${region}|${platform}`}
        onSubmit={handleResubmit}
        initialRiotId={riotId}
        initialRegion={region}
        initialPlatform={platform}
        busy={loading}
      />

      {/* Decision 3 */}
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
