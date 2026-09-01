import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { ClashRosterCard, ClashScoutingReport } from '../api/types';
import { StaticDataContext, buildStaticDataIndex, createStaticDataProvider } from '../staticData';
import { ClashScoutingView } from './ClashScoutingView';

const VERSION = '16.17.1';
const CHAMPION_JSON = {
  data: {
    Aatrox: { name: 'Aatrox', image: { full: 'Aatrox.png' }, key: '266' },
    Ahri: { name: 'Ahri', image: { full: 'Ahri.png' }, key: '103' },
  },
};

function renderView(ui: ReactElement) {
  const provider = createStaticDataProvider(VERSION, buildStaticDataIndex(VERSION, CHAMPION_JSON, { data: {} }));
  return render(
    <MemoryRouter>
      <StaticDataContext.Provider value={provider}>{ui}</StaticDataContext.Provider>
    </MemoryRouter>,
  );
}

function rosterCard(over: Partial<ClashRosterCard> = {}): ClashRosterCard {
  return {
    puuid: 'a',
    declaredPosition: 'MIDDLE',
    isCaptain: false,
    riotId: { gameName: 'Player', tagLine: 'NA1' },
    rankedEntries: [{ tier: 'GOLD', division: 'II', winRatePercent: 60, leaguePoints: 40 }],
    championPool: [{ championId: 266, masteryPoints: 50_000, masteryLevel: 7 }],
    recentForm: [{ matchId: 'NA1_1', championId: 266, role: 'MIDDLE', win: true }],
    observedRole: 'MIDDLE',
    ...over,
  };
}

function report(over: Partial<ClashScoutingReport> = {}): ClashScoutingReport {
  return {
    team: { id: 't1', name: 'Test Team', abbreviation: 'TST', tier: 1, iconId: 1, captainPuuid: 'a' },
    tournament: null,
    roster: [rosterCard({ puuid: 'a' }), rosterCard({ puuid: 'b', isCaptain: false })],
    insights: {
      banRecommendations: [{ championId: 266, puuid: 'a', masteryPoints: 50_000, recentGames: 3, recentWins: 2 }],
      positionMismatches: [],
      stackCohesion: 0,
    },
    ...over,
  };
}

describe('ClashScoutingView', () => {
  it('renders one roster card per member', () => {
    renderView(<ClashScoutingView report={report()} />);
    expect(screen.getAllByTestId('roster-card')).toHaveLength(2);
  });

  it("links each roster member's tag to their own profile", () => {
    renderView(<ClashScoutingView report={report({ roster: [rosterCard({ puuid: 'a', riotId: { gameName: 'Scoutee', tagLine: 'NA1' } })] })} />);
    expect(screen.getByTestId('player-link')).toHaveAttribute('href', '/profile?riotId=Scoutee%23NA1');
  });

  it('shows the captain badge only on the captain', () => {
    renderView(
      <ClashScoutingView
        report={report({ roster: [rosterCard({ puuid: 'a', isCaptain: true }), rosterCard({ puuid: 'b', isCaptain: false })] })}
      />,
    );
    const cards = screen.getAllByTestId('roster-card');
    expect(within(cards[0]).queryByTestId('captain-badge')).toBeInTheDocument();
    expect(within(cards[1]).queryByTestId('captain-badge')).toBeNull();
  });

  it('renders the tournament name only when present (Requirement 4.4)', () => {
    const { rerender } = renderView(<ClashScoutingView report={report({ tournament: null })} />);
    expect(screen.queryByTestId('clash-tournament')).toBeNull();
    rerender(
      <MemoryRouter>
        <StaticDataContext.Provider
          value={createStaticDataProvider(VERSION, buildStaticDataIndex(VERSION, CHAMPION_JSON, { data: {} }))}
        >
          <ClashScoutingView
            report={report({ tournament: { id: 1, nameKey: 'clash_theme', nameKeySecondary: 'clash_theme_secondary' } })}
          />
        </StaticDataContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('clash-tournament')).toHaveTextContent('clash_theme');
  });

  it('renders the ban recommendations in the backend-declared order', () => {
    renderView(
      <ClashScoutingView
        report={report({
          insights: {
            banRecommendations: [
              { championId: 266, puuid: 'a', masteryPoints: 1, recentGames: 1, recentWins: 1 },
              { championId: 103, puuid: 'b', masteryPoints: 1, recentGames: 1, recentWins: 0 },
            ],
            positionMismatches: [],
            stackCohesion: 0,
          },
        })}
      />,
    );
    const rows = screen.getAllByTestId('ban-recommendation');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Aatrox');
    expect(rows[1]).toHaveTextContent('Ahri');
  });

  it('shows a distinct empty note when there are no ban recommendations', () => {
    renderView(
      <ClashScoutingView
        report={report({ insights: { banRecommendations: [], positionMismatches: [], stackCohesion: 0 } })}
      />,
    );
    expect(screen.queryByTestId('ban-recommendations')).toBeNull();
    expect(screen.getByText(/not enough data/i)).toBeInTheDocument();
  });

  it('flags a roster member named in positionMismatches, and no one else', () => {
    renderView(
      <ClashScoutingView
        report={report({
          roster: [
            rosterCard({ puuid: 'a', declaredPosition: 'TOP', observedRole: 'JUNGLE' }),
            rosterCard({ puuid: 'b' }),
          ],
          insights: {
            banRecommendations: [],
            positionMismatches: [{ puuid: 'a', declaredPosition: 'TOP', observedRole: 'JUNGLE' }],
            stackCohesion: 0,
          },
        })}
      />,
    );
    const cards = screen.getAllByTestId('roster-card');
    expect(within(cards[0]).getByTestId('position-mismatch-flag')).toBeInTheDocument();
    expect(within(cards[1]).queryByTestId('position-mismatch-flag')).toBeNull();
  });

  it('distinguishes an unranked member from one whose League call failed', () => {
    renderView(
      <ClashScoutingView
        report={report({
          roster: [
            rosterCard({ puuid: 'unranked', rankedEntries: [] }),
            rosterCard({ puuid: 'failed', rankedEntries: null }),
          ],
        })}
      />,
    );
    const cards = screen.getAllByTestId('roster-card');
    expect(within(cards[0]).getByText('Unranked')).toBeInTheDocument();
    expect(within(cards[1]).queryByText('Unranked')).toBeNull();
  });

  it('shows the stack cohesion count', () => {
    renderView(<ClashScoutingView report={report({ insights: { banRecommendations: [], positionMismatches: [], stackCohesion: 3 } })} />);
    expect(screen.getByTestId('stack-cohesion')).toHaveTextContent('3 of 2 members queue together');
  });
});
