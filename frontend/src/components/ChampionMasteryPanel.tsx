/**
 * Sidebar section: top 5 champions by Champion-Mastery-V4 points, with the
 * analyzed player's mastery-point total, win rate, and games played on each —
 * joined against the full match window by the backend, never queue-filtered
 * (a champion's mastery points have no queue dimension). Sits between
 * `ChampionPreferences` and `RolePerformancePanel` in the sidebar.
 *
 * Champion identity here is a numeric `championId` (Champion-Mastery-V4 has
 * no champion name), resolved to the Champion_Key `ChampionIcon` needs via
 * `useStaticData().championKeyForId` — the same pattern `ParticipantCard`
 * (live-game) already uses for the same reason.
 */

import type { ChampionMasteryEntry } from '../api/types';
import { formatMasteryPoints } from '../domain/format';
import { useStaticData } from '../staticData';
import { ChampionIcon } from './ChampionIcon';

export interface ChampionMasteryPanelProps {
  champions: readonly ChampionMasteryEntry[];
}

export function ChampionMasteryPanel({ champions }: ChampionMasteryPanelProps) {
  const provider = useStaticData();

  if (champions.length === 0) {
    return (
      <p data-testid="no-champion-mastery" className="empty-note">
        No champion mastery data available.
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
          <th scope="col">Mastery</th>
          <th scope="col">Games</th>
          <th scope="col">WR</th>
        </tr>
      </thead>
      <tbody>
        {champions.map((champion) => {
          const championKey = provider.championKeyForId(champion.championId) ?? String(champion.championId);
          return (
            <tr key={champion.championId} data-testid={`champion-mastery-${champion.championId}`}>
              <th scope="row">
                <ChampionIcon championKey={championKey} size={24} className="champ-perf-icon" />
                <span className="sr-only">{championKey}</span>
              </th>
              <td>{formatMasteryPoints(champion.championPoints)}</td>
              <td>{champion.gamesPlayed}</td>
              <td className="champ-perf-wr">{champion.winRatePercent === null ? '—' : `${champion.winRatePercent}%`}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
