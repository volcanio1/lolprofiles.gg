import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RankSnapshot, RecentMatchSummary } from '../api/types';
import { rankColor } from '../domain/rankHistory';
import { RankHistoryGraph } from './RankHistoryGraph';

const snap = (tier: string, division: string, leaguePoints: number, observedAt: number): RankSnapshot => ({
  queueType: 'RANKED_SOLO_5x5',
  tier,
  division,
  leaguePoints,
  gamesPlayed: observedAt,
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

  it('labels the axis neutrally ("recorded over time"), never "games played" (Requirement 10.5)', () => {
    render(<RankHistoryGraph history={[snap('GOLD', 'IV', 10, 1), snap('GOLD', 'II', 50, 2)]} />);
    const graph = screen.getByTestId('rank-history-graph');
    expect(graph).toHaveTextContent('recorded over time');
    expect(graph).not.toHaveTextContent(/games played/i);
  });

  it('names the current rank', () => {
    render(<RankHistoryGraph history={[snap('GOLD', 'IV', 10, 1), snap('MASTER', 'I', 1182, 2)]} />);
    expect(screen.getByTestId('rank-history-graph')).toHaveTextContent('Master 1182 LP');
  });
});

const DAY = 86_400_000;

function match(over: Partial<RecentMatchSummary> = {}): RecentMatchSummary {
  return {
    matchId: 'NA1_1',
    championName: 'Ahri',
    role: 'MIDDLE',
    win: true,
    kills: 0,
    deaths: 0,
    assists: 0,
    cs: 0,
    csPerMinute: 0,
    visionScore: 0,
    startTimestamp: 0,
    durationSeconds: 1_800,
    opponent: null,
    build: { items: [0, 0, 0, 0, 0, 0], trinket: 0 },
    participants: [],
    queueType: 'ranked solo/duo',
    lpDelta: null,
    ...over,
  };
}

describe('RankHistoryGraph — hover tooltip (date, rank/LP, games since previous snapshot)', () => {
  it('shows the snapshot date and rank/LP on hover of the first point, with "First recorded snapshot" (no previous)', () => {
    render(
      <RankHistoryGraph
        history={[snap('GOLD', 'IV', 10, Date.UTC(2026, 7, 1)), snap('GOLD', 'II', 50, Date.UTC(2026, 7, 5))]}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId('rank-history-point-0'));

    const bubble = screen.getByRole('tooltip');
    expect(bubble).toHaveTextContent('Aug 1, 2026');
    expect(bubble).toHaveTextContent('Gold IV 10 LP');
    expect(bubble).toHaveTextContent('First recorded snapshot');
  });

  it('shows the number of ranked solo/duo games since the previous snapshot on hover of a later point', () => {
    const first = Date.UTC(2026, 7, 1);
    const second = Date.UTC(2026, 7, 5);
    render(
      <RankHistoryGraph
        history={[snap('GOLD', 'IV', 10, first), snap('GOLD', 'II', 50, second)]}
        recentMatches={[
          match({ matchId: 'm1', startTimestamp: first + DAY }),
          match({ matchId: 'm2', startTimestamp: first + 2 * DAY }),
          match({ matchId: 'm3', startTimestamp: second + DAY }), // after the window
          match({ matchId: 'm4', queueType: 'ranked flex', startTimestamp: first + DAY }), // wrong queue
        ]}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId('rank-history-point-1'));

    const bubble = screen.getByRole('tooltip');
    expect(bubble).toHaveTextContent('Aug 5, 2026');
    expect(bubble).toHaveTextContent('Gold II 50 LP');
    expect(bubble).toHaveTextContent('2 ranked games since previous snapshot');
  });

  it('colors the rank/LP line to the snapshot\'s tier', () => {
    render(
      <RankHistoryGraph
        history={[snap('GOLD', 'IV', 10, Date.UTC(2026, 7, 1)), snap('DIAMOND', 'II', 50, Date.UTC(2026, 7, 5))]}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId('rank-history-point-1'));

    const bubble = screen.getByRole('tooltip');
    const rankLine = within(bubble).getByText('Diamond II 50 LP');
    expect(rankLine).toHaveStyle({ color: rankColor('DIAMOND') });
  });

  it('each snapshot has its own hoverable band spanning the full graph height, not just a small dot', () => {
    render(
      <RankHistoryGraph
        history={[snap('GOLD', 'IV', 10, Date.UTC(2026, 7, 1)), snap('GOLD', 'II', 50, Date.UTC(2026, 7, 5))]}
      />,
    );
    const band = screen.getByTestId('rank-history-point-0').closest('.rank-graph-hit-band');
    expect(band).not.toBeNull();
    // Not hovering the dot's exact center — anywhere in its band still opens the tooltip.
    fireEvent.mouseEnter(screen.getByTestId('rank-history-point-0'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Gold IV 10 LP');
  });
});
