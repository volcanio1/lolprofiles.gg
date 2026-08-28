/**
 * The Live Game view embedded in a profile report's "Live game" tab.
 *
 * Same states as the standalone `/live` page minus the search form and the
 * `RiotDataPage` wrapper (the report already provides both). It is only mounted
 * while the tab is selected, so `useLiveGame` starts polling on mount and tears
 * the interval down on unmount (Requirement 5.5) — switching tabs stops the poll.
 */

import type { RiotIdParts } from '../api/types';
import { useLiveGame, type UseLiveGameOptions } from '../hooks/useLiveGame';
import { LiveGameView } from './LiveGameView';
import { LoadingIndicator } from './LoadingIndicator';

export interface LiveGamePanelProps {
  riotId: RiotIdParts;
  /** Injected in tests. */
  liveGameOptions?: UseLiveGameOptions;
}

export function LiveGamePanel({ riotId, liveGameOptions }: LiveGamePanelProps) {
  const { status, lobby, error, refresh } = useLiveGame(riotId, liveGameOptions);

  if (status === 'loading' || status === 'idle') {
    return <LoadingIndicator label="Checking for a live game…" />;
  }

  if (status === 'not_in_game') {
    return (
      <p data-testid="not-in-game" className="empty-note">
        This player is not currently in a game.
      </p>
    );
  }

  if (status === 'error' && error !== null) {
    return (
      <section role="alert" data-testid="live-error" className="error-notice">
        <p className="error-body">{error.message}</p>
        <button type="button" className="btn btn-ghost" data-testid="live-retry" onClick={refresh}>
          Try again
        </button>
      </section>
    );
  }

  if (status === 'ended') {
    return (
      <p data-testid="game-ended" className="empty-note">
        This game has ended — it will appear in Recent matches once Riot publishes the results.
      </p>
    );
  }

  return lobby !== null ? <LiveGameView lobby={lobby} /> : null;
}
