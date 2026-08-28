import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LiveGameLobby } from '../api/types';
import type { LiveGameOutcome } from '../api/lookupClient';
import { useLiveGame, type UseLiveGameOptions } from './useLiveGame';

const RIOT_ID = { gameName: 'Faker', tagLine: 'KR1' };

function lobby(over: Partial<LiveGameLobby> = {}): LiveGameLobby {
  return {
    gameId: 1,
    platformId: 'KR',
    matchId: 'KR_1',
    queueId: 420,
    mapId: 11,
    gameStartTime: 1_000,
    bannedChampionIds: [],
    participants: [],
    insights: { offChampion: [], oneTricks: [], rankSpread: null },
    ...over,
  };
}

/** A `schedule` that captures the poll callback so a test can fire it by hand. */
function manualScheduler() {
  const runs: Array<() => void> = [];
  const cancels: Array<() => void> = [];
  const schedule: UseLiveGameOptions['schedule'] = (_ms, run) => {
    runs.push(run);
    const cancel = vi.fn();
    cancels.push(cancel);
    return cancel;
  };
  return {
    schedule,
    poll: () => act(() => runs.at(-1)?.()),
    lastCancel: () => cancels.at(-1),
  };
}

describe('useLiveGame', () => {
  it('fetches on mount and reports in_game', async () => {
    const fetchLiveGame = vi.fn(async (): Promise<LiveGameOutcome> => ({ kind: 'in_game', lobby: lobby() }));
    const scheduler = manualScheduler();
    const { result } = renderHook(() => useLiveGame(RIOT_ID, { fetchLiveGame, schedule: scheduler.schedule }));

    await waitFor(() => expect(result.current.status).toBe('in_game'));
    expect(result.current.lobby?.matchId).toBe('KR_1');
    expect(fetchLiveGame).toHaveBeenCalledTimes(1);
  });

  it('polls on the scheduled callback', async () => {
    const outcomes: LiveGameOutcome[] = [
      { kind: 'in_game', lobby: lobby({ matchId: 'KR_1' }) },
      { kind: 'in_game', lobby: lobby({ matchId: 'KR_2' }) },
    ];
    const fetchLiveGame = vi.fn(async () => outcomes.shift() ?? ({ kind: 'not_in_game' } as LiveGameOutcome));
    const scheduler = manualScheduler();
    const { result } = renderHook(() => useLiveGame(RIOT_ID, { fetchLiveGame, schedule: scheduler.schedule }));

    await waitFor(() => expect(result.current.lobby?.matchId).toBe('KR_1'));
    await scheduler.poll();
    await waitFor(() => expect(result.current.lobby?.matchId).toBe('KR_2'));
  });

  it('switches to the game-ended state when a shown lobby returns not_in_game', async () => {
    const outcomes: LiveGameOutcome[] = [{ kind: 'in_game', lobby: lobby() }, { kind: 'not_in_game' }];
    const fetchLiveGame = vi.fn(async () => outcomes.shift() ?? ({ kind: 'not_in_game' } as LiveGameOutcome));
    const scheduler = manualScheduler();
    const { result } = renderHook(() => useLiveGame(RIOT_ID, { fetchLiveGame, schedule: scheduler.schedule }));

    await waitFor(() => expect(result.current.status).toBe('in_game'));
    await scheduler.poll();
    await waitFor(() => expect(result.current.status).toBe('ended'));
    // the last lobby is kept so the page can still link to the finished match
    expect(result.current.lobby).not.toBeNull();
  });

  it('reports not_in_game (not ended) when the player was never in a game', async () => {
    const fetchLiveGame = vi.fn(async (): Promise<LiveGameOutcome> => ({ kind: 'not_in_game' }));
    const scheduler = manualScheduler();
    const { result } = renderHook(() => useLiveGame(RIOT_ID, { fetchLiveGame, schedule: scheduler.schedule }));
    await waitFor(() => expect(result.current.status).toBe('not_in_game'));
  });

  it('a failed poll does not discard a lobby already on screen', async () => {
    const outcomes: LiveGameOutcome[] = [
      { kind: 'in_game', lobby: lobby() },
      { kind: 'error', error: { code: 'RIOT_UNAVAILABLE', message: 'down', retriable: true } },
    ];
    const fetchLiveGame = vi.fn(async () => outcomes.shift() ?? ({ kind: 'not_in_game' } as LiveGameOutcome));
    const scheduler = manualScheduler();
    const { result } = renderHook(() => useLiveGame(RIOT_ID, { fetchLiveGame, schedule: scheduler.schedule }));

    await waitFor(() => expect(result.current.status).toBe('in_game'));
    await scheduler.poll();
    await waitFor(() => expect(result.current.error?.code).toBe('RIOT_UNAVAILABLE'));
    expect(result.current.status).toBe('in_game');
    expect(result.current.lobby).not.toBeNull();
  });

  it('stops polling on unmount (Requirement 5.5)', async () => {
    const fetchLiveGame = vi.fn(async (): Promise<LiveGameOutcome> => ({ kind: 'not_in_game' }));
    const scheduler = manualScheduler();
    const { unmount } = renderHook(() => useLiveGame(RIOT_ID, { fetchLiveGame, schedule: scheduler.schedule }));
    await waitFor(() => expect(fetchLiveGame).toHaveBeenCalled());
    unmount();
    expect(scheduler.lastCancel()).toHaveBeenCalled();
  });

  it('is idle with no Riot ID', () => {
    const scheduler = manualScheduler();
    const { result } = renderHook(() => useLiveGame(null, { fetchLiveGame: vi.fn(), schedule: scheduler.schedule }));
    expect(result.current.status).toBe('idle');
  });
});
