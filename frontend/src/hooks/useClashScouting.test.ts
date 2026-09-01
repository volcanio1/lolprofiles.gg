import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ClashScoutOutcome } from '../api/lookupClient';
import { useClashScouting } from './useClashScouting';

const RIOT_ID = { gameName: 'Faker', tagLine: 'KR1' };

const REPORT: ClashScoutOutcome & { kind: 'report' } = {
  kind: 'report',
  report: {
    team: { id: 't1', name: 'Team', abbreviation: 'TM', tier: 1, iconId: 1, captainPuuid: 'a' },
    tournament: null,
    roster: [],
    insights: { banRecommendations: [], positionMismatches: [], stackCohesion: 0 },
  },
};

describe('useClashScouting', () => {
  it('fetches on mount and reports a report', async () => {
    const fetchClashScout = vi.fn(async (): Promise<ClashScoutOutcome> => REPORT);
    const { result } = renderHook(() => useClashScouting(RIOT_ID, { fetchClashScout }));

    await waitFor(() => expect(result.current.status).toBe('report'));
    expect(result.current.report?.team.name).toBe('Team');
    expect(fetchClashScout).toHaveBeenCalledTimes(1);
    expect(fetchClashScout).toHaveBeenCalledWith(RIOT_ID, undefined);
  });

  it('reports not_registered as a state', async () => {
    const fetchClashScout = vi.fn(async (): Promise<ClashScoutOutcome> => ({ kind: 'not_registered' }));
    const { result } = renderHook(() => useClashScouting(RIOT_ID, { fetchClashScout }));
    await waitFor(() => expect(result.current.status).toBe('not_registered'));
  });

  it('reports multiple_teams with the team list', async () => {
    const teams = [{ id: 't1', name: 'One', abbreviation: 'ONE', tier: 1, iconId: 1 }];
    const fetchClashScout = vi.fn(async (): Promise<ClashScoutOutcome> => ({ kind: 'multiple_teams', teams }));
    const { result } = renderHook(() => useClashScouting(RIOT_ID, { fetchClashScout }));
    await waitFor(() => expect(result.current.status).toBe('multiple_teams'));
    expect(result.current.teams).toEqual(teams);
  });

  it('selectTeam re-fetches with the chosen teamId', async () => {
    const fetchClashScout = vi.fn(async (_riotId, teamId?: string): Promise<ClashScoutOutcome> =>
      teamId === undefined
        ? { kind: 'multiple_teams', teams: [{ id: 't2', name: 'Two', abbreviation: 'TWO', tier: 1, iconId: 1 }] }
        : REPORT,
    );
    const { result } = renderHook(() => useClashScouting(RIOT_ID, { fetchClashScout }));
    await waitFor(() => expect(result.current.status).toBe('multiple_teams'));

    result.current.selectTeam('t2');
    await waitFor(() => expect(result.current.status).toBe('report'));
    expect(fetchClashScout).toHaveBeenLastCalledWith(RIOT_ID, 't2');
  });

  it('surfaces an error and refresh retries the same request', async () => {
    const outcomes: ClashScoutOutcome[] = [
      { kind: 'error', error: { code: 'RIOT_UNAVAILABLE', message: 'down', retriable: true } },
      REPORT,
    ];
    const fetchClashScout = vi.fn(async () => outcomes.shift() ?? REPORT);
    const { result } = renderHook(() => useClashScouting(RIOT_ID, { fetchClashScout }));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.code).toBe('RIOT_UNAVAILABLE');

    result.current.refresh();
    await waitFor(() => expect(result.current.status).toBe('report'));
  });

  it('is idle with a null Riot ID and issues no fetch', () => {
    const fetchClashScout = vi.fn(async (): Promise<ClashScoutOutcome> => REPORT);
    const { result } = renderHook(() => useClashScouting(null, { fetchClashScout }));
    expect(result.current.status).toBe('idle');
    expect(fetchClashScout).not.toHaveBeenCalled();
  });
});
