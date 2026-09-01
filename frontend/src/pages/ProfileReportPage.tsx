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
import { fetchCachedReport as realFetchCachedReport } from '../api/lookupClient';
import { ErrorNotice } from '../components/ErrorNotice';
import { LoadingIndicator } from '../components/LoadingIndicator';
import { ProfileReportView } from '../components/ProfileReportView';
import { RefreshControl } from '../components/RefreshControl';
import { SearchForm, type SearchSubmission } from '../components/SearchForm';
import { SEO } from '../components/SEO';
import { RiotDataPage } from '../compliance/RiotDataPage';
import { useLookup, type UseLookupOptions } from '../hooks/useLookup';

export interface ProfileReportPageProps {
  /** Injected in tests; production uses the real client, clock and scheduler. */
  lookupOptions?: UseLookupOptions;
  /** Injected in tests; production uses the real cached-report fetch. */
  fetchCachedReport?: typeof realFetchCachedReport;
}

export function ProfileReportPage({ lookupOptions, fetchCachedReport = realFetchCachedReport }: ProfileReportPageProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams();

  const riotId = (searchParams.get('riotId') ?? '').trim();
  // autofill-search Requirement 9.8: only a dropdown selection carries this.
  const fromSuggestion = searchParams.get('src') === 'suggest';

  const {
    status,
    report,
    error,
    loading,
    canRetry,
    retriesRemaining,
    cooldownSecondsRemaining,
    start,
    retry,
    seedFromSnapshot,
    refresh,
    refreshDisabled,
    refreshing,
    refreshError,
    fetchedAt,
  } = useLookup(lookupOptions);

  /**
   * Decision 1: the URL is the session's input, so a changed `riotId` starts a
   * new session. `src=suggest` (set only by a dropdown pick) is read fresh rather
   * than being a dependency, so stripping it after the first render does NOT
   * re-run this effect — only a genuinely different `riotId` does. The `cancelled`
   * flag is the StrictMode-safe pattern: a discarded first invocation applies
   * nothing, the retained one applies its result.
   */
  useEffect(() => {
    if (riotId.length === 0) {
      return;
    }
    let cancelled = false;

    const stripSrc = () => {
      if (!fromSuggestion) {
        return;
      }
      const next = new URLSearchParams(searchParams);
      next.delete('src');
      setSearchParams(next, { replace: true });
    };

    if (!fromSuggestion) {
      start({ riotId });
      return;
    }

    // autofill-search Requirement 9.9/9.10: try the stored snapshot, else live.
    const [gameName, tagLine] = riotId.split('#');
    void (async () => {
      const result = await fetchCachedReport(gameName ?? '', tagLine ?? '');
      if (cancelled) {
        return;
      }
      if (result.source === 'cache') {
        seedFromSnapshot({ riotId }, result.report, Date.parse(result.fetchedAt));
      } else {
        start({ riotId });
      }
      stripSrc();
    })();

    return () => {
      cancelled = true;
    };
    // `start` / `seedFromSnapshot` / `fetchCachedReport` are stable; `riotId` is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riotId, start, seedFromSnapshot]);

  function handleResubmit(submission: SearchSubmission) {
    setSearchParams(new URLSearchParams({ riotId: submission.riotId }));
  }

  function handleSelectSuggestion(submission: SearchSubmission) {
    setSearchParams(new URLSearchParams({ riotId: submission.riotId, src: 'suggest' }));
  }

  // A Riot ID is present but the session hasn't dispatched yet: the mount tick,
  // or the `fetchCachedReport` round trip on a suggestion pick. Show the loader
  // so the page is never blank while it decides between a snapshot and a lookup.
  const preparing = riotId.length > 0 && status === 'idle';

  const reportReady = status === 'success' && report !== undefined;
  const seoTitle = reportReady ? `${report.riotId.gameName}#${report.riotId.tagLine}` : 'Profile Report';
  const seoDescription = reportReady
    ? `${report.riotId.gameName}#${report.riotId.tagLine}'s League of Legends ranked stats, recent match history, champion mastery and performance insights.`
    : 'Look up a League of Legends player by Riot ID for ranked standing, recent match history and performance insights.';

  return (
    <RiotDataPage title="Profile report">
      {/* Individual profile reports are genuinely indexable content; the empty
          prompt / loading / error states carry nothing worth surfacing in
          search results. */}
      <SEO title={seoTitle} description={seoDescription} noindex={!reportReady} />
      {/*
        Decision 3. The `key` remounts the form whenever the URL changes, so its
        field always agrees with the report beside it. `SearchForm` seeds its own
        state from `initialRiotId`, which React only reads on mount — without the
        key, pressing Back would leave the form showing the previous Riot ID while
        the report showed a different one.
      */}
      <SearchForm
        key={riotId}
        onSubmit={handleResubmit}
        onSelectSuggestion={handleSelectSuggestion}
        initialRiotId={riotId}
        busy={loading}
      />

      {/* Decision 2 */}
      {riotId.length === 0 ? (
        <p data-testid="no-riot-id-prompt" className="prompt">
          Enter a Riot ID above to see a profile report.
        </p>
      ) : null}

      {/* Requirement 9.6, plus the pre-dispatch window (mount / cached-report probe). */}
      {loading || preparing ? (
        <LoadingIndicator label={preparing ? 'Loading profile…' : undefined} />
      ) : null}

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

      {status === 'success' && report !== undefined ? (
        <>
          {/* autofill-search Requirement 10 */}
          <RefreshControl
            fetchedAt={fetchedAt}
            disabled={refreshDisabled}
            refreshing={refreshing}
            onRefresh={refresh}
          />
          {refreshing ? <LoadingIndicator label="Refreshing…" /> : null}
          {/* Requirement 10.5: a failed refresh leaves the report in place. */}
          {refreshError !== undefined ? (
            <p role="status" data-testid="refresh-error" className="notice-warning">
              {refreshError.message}
            </p>
          ) : null}
          <div className={refreshing ? 'report-refreshing' : undefined} aria-busy={refreshing || undefined}>
            <ProfileReportView report={report} />
          </div>
        </>
      ) : null}
    </RiotDataPage>
  );
}
