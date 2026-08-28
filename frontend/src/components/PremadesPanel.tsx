/**
 * The premades panel for the sidebar: teammates the player keeps queueing with,
 * with shared games and win rate together, scoped to the selected gamemode
 * filter. Compact table, same style as champion preferences / role performance.
 * Win rate is shown in the gold accent, never green/red.
 */

import type { PremadeEntry } from '../api/types';

export interface PremadesPanelProps {
  premades: readonly PremadeEntry[];
}

export function PremadesPanel({ premades }: PremadesPanelProps) {
  if (premades.length === 0) {
    return (
      <p data-testid="no-premades" className="empty-note">
        No recurring teammates in this match window.
      </p>
    );
  }

  return (
    <table className="premade-perf">
      <thead>
        <tr>
          <th scope="col">
            <span className="sr-only">Teammate</span>
          </th>
          <th scope="col">Games</th>
          <th scope="col">WR</th>
        </tr>
      </thead>
      <tbody>
        {premades.map((entry) => (
          <tr key={`${entry.gameName}#${entry.tagLine}`} data-testid={`premade-${entry.gameName}`}>
            <th scope="row" className="premade-name">
              {entry.gameName}
              <span className="premade-tag">#{entry.tagLine}</span>
            </th>
            <td>{entry.gamesPlayed}</td>
            <td className="premade-wr">{entry.winRatePercent}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
