import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { LiveGameLobby, LiveParticipantCard } from '../api/types';
import { StaticDataContext, buildStaticDataIndex, createStaticDataProvider } from '../staticData';
import { LiveGameView } from './LiveGameView';

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

function card(over: Partial<LiveParticipantCard> = {}): LiveParticipantCard {
  return {
    puuid: 'p',
    teamId: 100,
    championId: 266,
    spell1Id: 4,
    spell2Id: 7,
    perkIds: [8005],
    isBot: false,
    riotId: { gameName: 'Player', tagLine: 'NA1' },
    rankedEntries: [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', division: 'II', leaguePoints: 40, wins: 5, losses: 5 }],
    championMasteryPoints: 50_000,
    championMasteryLevel: 7,
    ...over,
  };
}

function lobby(over: Partial<LiveGameLobby> = {}): LiveGameLobby {
  return {
    gameId: 9,
    platformId: 'NA1',
    matchId: 'NA1_9',
    queueId: 420,
    mapId: 11,
    gameStartTime: 0,
    bannedChampionIds: [],
    participants: [card({ puuid: 'a', teamId: 100 }), card({ puuid: 'b', teamId: 200 })],
    insights: { offChampion: [], oneTricks: [], rankSpread: null },
    ...over,
  };
}

describe('LiveGameView', () => {
  it('splits participants into the two teams', () => {
    renderView(<LiveGameView lobby={lobby()} />);
    expect(within(screen.getByTestId('team-100')).getAllByTestId('participant-card')).toHaveLength(1);
    expect(within(screen.getByTestId('team-200')).getAllByTestId('participant-card')).toHaveLength(1);
  });

  it("links a resolved participant's name to their profile", () => {
    renderView(
      <LiveGameView
        lobby={lobby({ participants: [card({ puuid: 'a', riotId: { gameName: 'Locked', tagLine: 'NA1' } })] })}
      />,
    );
    expect(screen.getByTestId('player-link')).toHaveAttribute('href', '/profile?riotId=Locked%23NA1');
  });

  it('does not link a bot or an unresolved participant', () => {
    renderView(<LiveGameView lobby={lobby({ participants: [card({ puuid: 'bot', isBot: true, riotId: null })] })} />);
    expect(screen.queryByTestId('player-link')).toBeNull();
  });

  it('renders Pre-Game rather than a clock for a zero start timestamp (Requirement 4.2)', () => {
    renderView(<LiveGameView lobby={lobby({ gameStartTime: 0 })} />);
    expect(screen.getByTestId('game-clock')).toHaveTextContent(/champion select/i);
  });

  it('shows the rank spread only when the lobby has one (Requirement 3.5)', () => {
    const { rerender } = renderView(<LiveGameView lobby={lobby()} />);
    expect(screen.queryByTestId('rank-spread')).toBeNull();
    rerender(
      <MemoryRouter>
        <StaticDataContext.Provider
          value={createStaticDataProvider(VERSION, buildStaticDataIndex(VERSION, CHAMPION_JSON, { data: {} }))}
        >
          <LiveGameView lobby={lobby({ insights: { offChampion: [], oneTricks: [], rankSpread: { highest: 'DIAMOND', lowest: 'SILVER' } } })} />
        </StaticDataContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('rank-spread')).toHaveTextContent('Silver – Diamond');
  });

  it('renders a bot distinctly and without rank or mastery', () => {
    renderView(
      <LiveGameView
        lobby={lobby({
          participants: [card({ puuid: 'bot', isBot: true, riotId: null, rankedEntries: null, championMasteryPoints: null })],
        })}
      />,
    );
    const bot = screen.getByTestId('participant-card');
    expect(bot).toHaveTextContent('Bot');
    expect(bot.className).toContain('live-card--bot');
    expect(screen.queryByTestId('participant-mastery')).toBeNull();
  });

  it('distinguishes an unranked player from one whose enrichment failed', () => {
    renderView(
      <LiveGameView
        lobby={lobby({
          participants: [
            card({ puuid: 'unranked', teamId: 100, rankedEntries: [] }),
            card({ puuid: 'failed', teamId: 200, rankedEntries: null }),
          ],
        })}
      />,
    );
    expect(within(screen.getByTestId('team-100')).getByText('Unranked')).toBeInTheDocument();
    expect(within(screen.getByTestId('team-200')).queryByText('Unranked')).toBeNull();
  });

  it('surfaces the off-champion and one-trick flags on the flagged players', () => {
    renderView(
      <LiveGameView
        lobby={lobby({
          participants: [card({ puuid: 'ot', teamId: 100 }), card({ puuid: 'oc', teamId: 200 })],
          insights: { offChampion: ['oc'], oneTricks: ['ot'], rankSpread: null },
        })}
      />,
    );
    expect(within(screen.getByTestId('team-100')).getByTestId('flag-onetrick')).toBeInTheDocument();
    expect(within(screen.getByTestId('team-200')).getByTestId('flag-offchamp')).toBeInTheDocument();
  });
});
