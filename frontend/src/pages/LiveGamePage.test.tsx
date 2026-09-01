import { render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { LiveGameOutcome } from '../api/lookupClient';
import type { LiveGameLobby } from '../api/types';
import { RIOT_ATTRIBUTION_TEXT } from '../compliance/RiotDataPage';
import type { UseLiveGameOptions } from '../hooks/useLiveGame';
import { StaticDataContext, buildStaticDataIndex, createStaticDataProvider } from '../staticData';
import { LiveGamePage } from './LiveGamePage';

const VERSION = '16.17.1';

function provider() {
  return createStaticDataProvider(VERSION, buildStaticDataIndex(VERSION, { data: {} }, { data: {} }));
}

function renderPage(path: string, liveGameOptions?: UseLiveGameOptions): ReactElement | void {
  render(
    <HelmetProvider>
      <StaticDataContext.Provider value={provider()}>
        <MemoryRouter initialEntries={[path]}>
          <LiveGamePage liveGameOptions={liveGameOptions} />
        </MemoryRouter>
      </StaticDataContext.Provider>
    </HelmetProvider>,
  );
}

const noSchedule: UseLiveGameOptions['schedule'] = () => () => undefined;

function lobby(over: Partial<LiveGameLobby> = {}): LiveGameLobby {
  return {
    gameId: 1,
    platformId: 'KR',
    matchId: 'KR_1',
    queueId: 420,
    mapId: 11,
    gameStartTime: 0,
    bannedChampionIds: [],
    participants: [],
    insights: { offChampion: [], oneTricks: [], rankSpread: null },
    ...over,
  };
}

describe('LiveGamePage', () => {
  it('prompts for a Riot ID when the URL carries none, and still shows attribution (Requirement 8.1)', () => {
    renderPage('/live', { fetchLiveGame: vi.fn(), schedule: noSchedule });
    expect(screen.getByTestId('no-riot-id-prompt')).toBeInTheDocument();
    expect(screen.getByTestId('riot-attribution')).toHaveTextContent(RIOT_ATTRIBUTION_TEXT);
    expect(screen.queryByTestId('advertising-slot')).toBeNull();
  });

  it('renders the lobby for an in_game player', async () => {
    const fetchLiveGame = vi.fn(async (): Promise<LiveGameOutcome> => ({ kind: 'in_game', lobby: lobby() }));
    renderPage('/live?riotId=Faker%23KR1', { fetchLiveGame, schedule: noSchedule });
    await waitFor(() => expect(screen.getByTestId('live-game')).toBeInTheDocument());
    expect(fetchLiveGame).toHaveBeenCalledWith({ gameName: 'Faker', tagLine: 'KR1' });
  });

  it('shows the not-in-a-game message, not an error', async () => {
    const fetchLiveGame = vi.fn(async (): Promise<LiveGameOutcome> => ({ kind: 'not_in_game' }));
    renderPage('/live?riotId=Faker%23KR1', { fetchLiveGame, schedule: noSchedule });
    await waitFor(() => expect(screen.getByTestId('not-in-game')).toBeInTheDocument());
    expect(screen.queryByTestId('live-error')).toBeNull();
  });

  it('shows an inline error with a retry for a failed lookup', async () => {
    const fetchLiveGame = vi.fn(async (): Promise<LiveGameOutcome> => ({
      kind: 'error',
      error: { code: 'RIOT_UNAVAILABLE', message: 'Riot is down.', retriable: true },
    }));
    renderPage('/live?riotId=Faker%23KR1', { fetchLiveGame, schedule: noSchedule });
    await waitFor(() => expect(screen.getByTestId('live-error')).toHaveTextContent('Riot is down.'));
    expect(screen.getByTestId('live-retry')).toBeInTheDocument();
  });
});
