/**
 * The Clash Scouting view embedded in a profile report's "Clash" tab
 * (clash-scouting task 8, decision recorded 2026-09-01: a third tab beside
 * "Recent matches" and "Live game", not a standalone page).
 *
 * Same shape as `LiveGamePanel`: no search form, no `RiotDataPage` wrapper (the
 * report already provides both). Only mounted while the tab is selected, so
 * `useClashScouting` fetches on mount and the request is abandoned (via the
 * hook's request-id guard) on unmount or a Riot ID change.
 */

import type { RiotIdParts } from '../api/types';
import { useClashScouting, type UseClashScoutingOptions } from '../hooks/useClashScouting';
import { LoadingIndicator } from './LoadingIndicator';
import { ClashScoutingView } from './ClashScoutingView';
import { ClashTeamPicker } from './ClashTeamPicker';

export interface ClashScoutingPanelProps {
  riotId: RiotIdParts;
  /** Injected in tests. */
  clashScoutingOptions?: UseClashScoutingOptions;
}

export function ClashScoutingPanel({ riotId, clashScoutingOptions }: ClashScoutingPanelProps) {
  const { status, report, teams, error, selectTeam, refresh } = useClashScouting(riotId, clashScoutingOptions);

  if (status === 'loading' || status === 'idle') {
    return <LoadingIndicator label="Checking for an active Clash registration…" />;
  }

  if (status === 'not_registered') {
    return (
      <p data-testid="clash-not-registered" className="empty-note">
        This player is not registered for an active Clash tournament.
      </p>
    );
  }

  if (status === 'multiple_teams') {
    return <ClashTeamPicker teams={teams} onSelect={selectTeam} />;
  }

  if (status === 'error' && error !== null) {
    return (
      <section role="alert" data-testid="clash-error" className="error-notice">
        <p className="error-body">{error.message}</p>
        <button type="button" className="btn btn-ghost" data-testid="clash-retry" onClick={refresh}>
          Try again
        </button>
      </section>
    );
  }

  return report !== null ? <ClashScoutingView report={report} /> : null;
}
