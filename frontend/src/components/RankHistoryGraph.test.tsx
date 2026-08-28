import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RankSnapshot } from '../api/types';
import { RankHistoryGraph } from './RankHistoryGraph';

const snap = (tier: string, division: string, leaguePoints: number, observedAt: number): RankSnapshot => ({
  queueType: 'RANKED_SOLO_5x5',
  tier,
  division,
  leaguePoints,
  observedAt,
});

describe('RankHistoryGraph', () => {
  it('shows the build-up message with fewer than two snapshots (Requirement 10.4)', () => {
    render(<RankHistoryGraph history={[]} />);
    expect(screen.getByTestId('rank-history-pending')).toBeInTheDocument();

    render(<RankHistoryGraph history={[snap('GOLD', 'II', 20, 1)]} />);
    expect(screen.getAllByTestId('rank-history-pending').length).toBeGreaterThan(0);
  });

  it('draws a polyline with one point per snapshot once there are two or more', () => {
    render(
      <RankHistoryGraph
        history={[snap('GOLD', 'IV', 10, 1), snap('GOLD', 'II', 50, 2), snap('PLATINUM', 'IV', 5, 3)]}
      />,
    );
    const graph = screen.getByTestId('rank-history-graph');
    const polyline = graph.querySelector('polyline');
    expect(polyline).not.toBeNull();
    expect((polyline?.getAttribute('points') ?? '').trim().split(/\s+/)).toHaveLength(3);
  });

  it('labels the axis "lookups over time", never "games played" (Requirement 10.5)', () => {
    render(<RankHistoryGraph history={[snap('GOLD', 'IV', 10, 1), snap('GOLD', 'II', 50, 2)]} />);
    const graph = screen.getByTestId('rank-history-graph');
    expect(graph).toHaveTextContent('lookups over time');
    expect(graph).not.toHaveTextContent(/games played/i);
  });

  it('names the current rank', () => {
    render(<RankHistoryGraph history={[snap('GOLD', 'IV', 10, 1), snap('MASTER', 'I', 1182, 2)]} />);
    expect(screen.getByTestId('rank-history-graph')).toHaveTextContent('Master 1182 LP');
  });
});
