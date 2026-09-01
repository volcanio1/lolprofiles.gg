/**
 * Search page (`/`).
 *
 * Implements Requirement 1.1's entry point and hands a validated submission to the
 * report route. It performs no lookup itself, so the two pages have one job each:
 * this one collects and validates input, `ProfileReportPage` runs the session.
 *
 * ---------------------------------------------------------------------------
 * THE DEFERRED `#`-IN-URL DECISION, NOW RESOLVED
 * ---------------------------------------------------------------------------
 *
 * Task 1.2 left `/profile` without a `:riotId` path parameter, because a Riot ID
 * contains `#` — the URL fragment delimiter — and encoding it inside a path segment
 * needs a scheme nothing had yet chosen.
 *
 * Resolved by passing the Riot ID as a QUERY PARAMETER via `URLSearchParams`, which
 * percent-encodes `#` as `%23` automatically and decodes it symmetrically on read.
 * No custom encoding is invented, the report URL is shareable and bookmarkable, and
 * both routes keep a distinct purpose. A path parameter would have required either a
 * hand-rolled substitution (a second encoding scheme to get wrong) or dropping the
 * separator from the URL and reconstructing it, which cannot round-trip a `#` that
 * appears in neither part.
 *
 * The search page renders inside `RiotDataPage` too: it displays no Riot data yet,
 * but Requirement 12.2's prohibition on advertising is cheaper to honor uniformly
 * than to apply per-page, and the attribution does no harm on the entry page.
 */

import { useNavigate } from 'react-router-dom';
import { SearchForm, type SearchSubmission } from '../components/SearchForm';
import { SEO } from '../components/SEO';
import { RiotDataPage } from '../compliance/RiotDataPage';

/**
 * Builds the report URL. `URLSearchParams` owns the encoding.
 *
 * lookup-pipeline-fixes: no `region`/`platform` query params anymore — the
 * platform is discovered server-side from the Riot ID alone.
 */
export function reportPathFor(submission: SearchSubmission, fromSuggestion = false): string {
  const params = new URLSearchParams({ riotId: submission.riotId });
  // autofill-search Requirement 9.8: mark suggestion-picked lookups so the report
  // page tries the cached snapshot first. `ProfileReportPage` strips it after the
  // first render, so a shared or reloaded link always runs a live lookup.
  if (fromSuggestion) {
    params.set('src', 'suggest');
  }
  return `/profile?${params.toString()}`;
}

export function SearchPage() {
  const navigate = useNavigate();

  return (
    <RiotDataPage title="Search a player" hero>
      <SEO
        title="lolprofiles.gg"
        description="Look up any League of Legends player by Riot ID for ranked standing, recent match history, live games, champion mastery and performance insights."
      />
      <p className="lede">
        Enter a Riot ID to see ranked standing, recent form, habits and improvement suggestions.
      </p>
      <SearchForm
        onSubmit={(submission) => {
          navigate(reportPathFor(submission));
        }}
        onSelectSuggestion={(submission) => {
          navigate(reportPathFor(submission, true));
        }}
      />
    </RiotDataPage>
  );
}
