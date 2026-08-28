/**
 * Live Game page (`/live?riotId=...`).
 *
 * Collects a Riot ID (prefilled from the URL), runs a `useLiveGame` polling
 * session, and renders exactly one of: a prompt (no Riot ID), the loading state,
 * an error with a retry, "not currently in a game", the live lobby, or the
 * game-ended state.
 *
 *  - 5.1/5.5: polling and its teardown live in `useLiveGame`; this page only
 *    reads its status.
 *  - 5.2/5.3: the game-ended state links to the player's profile, where the
 *    finished match appears in Recent Matches once Riot publishes it. (This app
 *    has no standalone match page; the profile is the closest destination.)
 *  - 8.1/8.2: rendered through `RiotDataPage`, so attribution and the
 *    no-advertising default apply without being re-implemented.
 *  - 8.3: no participant identifier beyond the Riot ID is shown (see `ParticipantCard`).
 */

import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { LiveGameView } from '../components/LiveGameView';
import { LoadingIndicator } from '../components/LoadingIndicator';
import { SearchForm, type SearchSubmission } from '../components/SearchForm';
import { RiotDataPage } from '../compliance/RiotDataPage';
import { validateRiotId } from '../domain/riotId';
import { useLiveGame, type UseLiveGameOptions } from '../hooks/useLiveGame';

export interface LiveGamePageProps {
  /** Injected in tests; production uses the real fetch + interval. */
  liveGameOptions?: UseLiveGameOptions;
}

export function LiveGamePage({ liveGameOptions }: LiveGamePageProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawRiotId = (searchParams.get('riotId') ?? '').trim();

  const riotId = useMemo(() => {
    const validation = validateRiotId(rawRiotId);
    return validation.ok ? validation.riotId : null;
  }, [rawRiotId]);

  const { status, lobby, error, refresh } = useLiveGame(riotId, liveGameOptions);

  function handleSubmit(submission: SearchSubmission) {
    setSearchParams(new URLSearchParams({ riotId: submission.riotId }));
  }

  const profileHref = riotId === null ? '/' : `/profile?riotId=${encodeURIComponent(rawRiotId)}`;

  return (
    <RiotDataPage title="Live game">
      <SearchForm key={rawRiotId} onSubmit={handleSubmit} initialRiotId={rawRiotId} busy={status === 'loading'} />

      {rawRiotId.length === 0 ? (
        <p data-testid="no-riot-id-prompt" className="prompt">
          Enter a Riot ID above to see the game a player is in right now.
        </p>
      ) : null}

      {status === 'loading' ? <LoadingIndicator label="Checking for a live game…" /> : null}

      {status === 'not_in_game' ? (
        <p data-testid="not-in-game" className="prompt">
          This player is not currently in a game.
        </p>
      ) : null}

      {status === 'error' && error !== null ? (
        <section role="alert" data-testid="live-error" className="error-notice">
          <p className="error-body">{error.message}</p>
          <button type="button" className="button" data-testid="live-retry" onClick={refresh}>
            Try again
          </button>
        </section>
      ) : null}

      {status === 'ended' ? (
        <section data-testid="game-ended" className="prompt">
          <p>This game has ended.</p>
          <Link to={profileHref} data-testid="finished-match-link">
            View this player&rsquo;s profile
          </Link>
          <p className="error-meta">Match results appear in Recent Matches once Riot publishes them.</p>
        </section>
      ) : null}

      {status === 'in_game' && lobby !== null ? <LiveGameView lobby={lobby} /> : null}
    </RiotDataPage>
  );
}
