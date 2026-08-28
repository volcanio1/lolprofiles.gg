/**
 * profile-sidebar Requirement 7: the champion-preferences panel for the sidebar.
 *
 * A compact table (dpm.lol-style), scoped to the Sidebar_Queue_Filter's selected
 * slice (`report.statsByQueue[value].topChampions`). Ordering and the 5-champion
 * cap are the backend's (Requirement 7.3) — this only renders. Win rate is shown
 * in the report's gold accent, never green/red (this project's palette rule).
 */

import type { ChampionSummary } from '../api/types';
import { formatKda } from '../domain/format';
import { ChampionIcon } from './ChampionIcon';

export interface ChampionPreferencesProps {
  champions: readonly ChampionSummary[];
}

export function ChampionPreferences({ champions }: ChampionPreferencesProps) {
  if (champions.length === 0) {
    // Requirement 7.4: same wording as the report's existing empty state.
    return (
      <p data-testid="no-champions" className="empty-note">
        No matches available to rank champions.
      </p>
    );
  }

  return (
    <table className="champ-perf">
      <thead>
        <tr>
          <th scope="col">
            <span className="sr-only">Champion</span>
          </th>
          <th scope="col">KDA</th>
          <th scope="col">CS/m</th>
          <th scope="col">Games</th>
          <th scope="col">WR</th>
        </tr>
      </thead>
      <tbody>
        {champions.map((champion) => (
          <tr key={champion.championName} data-testid={`champion-${champion.championName}`}>
            <th scope="row">
              <ChampionIcon championKey={champion.championName} size={24} className="champ-perf-icon" />
              <span className="sr-only">{champion.championName}</span>
            </th>
            <td>{formatKda(champion.averageKda)}</td>
            <td data-testid={`champion-${champion.championName}-avg-cs`}>
              {Number.isFinite(champion.averageCsPerMinute) ? champion.averageCsPerMinute.toFixed(1) : '0.0'}
            </td>
            <td>{champion.gamesPlayed}</td>
            <td className="champ-perf-wr">{champion.winRatePercent}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
