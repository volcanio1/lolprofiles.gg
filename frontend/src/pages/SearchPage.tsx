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
import { RiotDataPage } from '../compliance/RiotDataPage';

/** Builds the report URL. `URLSearchParams` owns the encoding. */
export function reportPathFor(submission: SearchSubmission): string {
  const params = new URLSearchParams({ riotId: submission.riotId, region: submission.region });
  if (submission.platform !== undefined && submission.platform.length > 0) {
    params.set('platform', submission.platform);
  }
  return `/profile?${params.toString()}`;
}

export function SearchPage() {
  const navigate = useNavigate();

  return (
    <RiotDataPage title="Search a player" hero>
      <p className="lede">
        Enter a Riot ID to see ranked standing, recent form, habits and improvement suggestions.
      </p>
      <SearchForm
        onSubmit={(submission) => {
          navigate(reportPathFor(submission));
        }}
      />
    </RiotDataPage>
  );
}
