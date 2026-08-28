/**
 * profile-sidebar Requirement 8: the role-performance panel for the sidebar.
 *
 * A compact table — role, games, win rate — scoped to the Sidebar_Queue_Filter's
 * selected slice (`report.rolePerformanceByQueue[value]`). Order and role
 * classification are the backend's. An empty slice shows an explicit message,
 * never a blank panel (Requirement 8.5).
 */

import type { RolePerformanceEntry } from '../api/types';

export interface RolePerformancePanelProps {
  roles: readonly RolePerformanceEntry[];
}

export function RolePerformancePanel({ roles }: RolePerformancePanelProps) {
  if (roles.length === 0) {
    return (
      <p data-testid="no-role-performance" className="empty-note">
        Not enough data to show role performance.
      </p>
    );
  }

  return (
    <table className="role-perf">
      <thead>
        <tr>
          <th scope="col">
            <span className="sr-only">Role</span>
          </th>
          <th scope="col">Games</th>
          <th scope="col">WR</th>
        </tr>
      </thead>
      <tbody>
        {roles.map((entry) => (
          <tr key={entry.role} data-testid={`role-perf-${entry.role}`}>
            <th scope="row">{entry.role}</th>
            <td>{entry.gamesPlayed}</td>
            <td>{entry.winRatePercent}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
