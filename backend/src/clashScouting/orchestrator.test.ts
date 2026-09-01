import { describe, expect, it, vi } from 'vitest';
import { createInMemoryCacheStore } from '../cache';
import type { RegionResolver } from '../regionResolver';
import type { RiotApiClient, RiotApiResult } from '../riotApiClient';
import type { RosterEnricher } from './enricher';
import { createScoutingOrchestrator, type ScoutingOrchestratorOptions } from './orchestrator';
import type { ClashPlayerDto, ClashTeamDto, ClashTournamentDto, RosterCard } from './types';

const ok = <T>(data: T): RiotApiResult<T> => ({ kind: 'ok', data });
const notFound = <T>(): RiotApiResult<T> => ({ kind: 'not_found' });

const RESOLVED: RegionResolver = { resolve: () => Promise.resolve({ kind: 'resolved', platform: 'na1', region: 'americas' }) };

const PASSTHROUGH_ENRICHER: RosterEnricher = {
  enrichAll: (_platform, _region, members) =>
    Promise.resolve(
      members.map(
        (m): RosterCard => ({
          puuid: m.puuid,
          declaredPosition: m.position,
          isCaptain: m.role === 'CAPTAIN',
          riotId: null,
          rankedEntries: null,
          championPool: null,
          recentForm: [],
          observedRole: null,
        }),
      ),
    ),
};

function registration(overrides: Partial<ClashPlayerDto> = {}): ClashPlayerDto {
  return { puuid: 'puuid-a', teamId: 'team-1', position: 'MIDDLE', role: 'MEMBER', ...overrides };
}

function team(overrides: Partial<ClashTeamDto> = {}): ClashTeamDto {
  return {
    id: 'team-1',
    tournamentId: 500,
    name: 'Test Team',
    iconId: 1,
    tier: 1,
    captain: 'puuid-a',
    abbreviation: 'TST',
    players: [
      { puuid: 'puuid-a', position: 'MIDDLE', role: 'CAPTAIN' },
      { puuid: 'puuid-b', position: 'TOP', role: 'MEMBER' },
    ],
    ...overrides,
  };
}

interface ClientOverrides {
  account?: () => RiotApiResult<{ puuid: string; gameName: string; tagLine: string }>;
  clashPlayers?: () => RiotApiResult<ClashPlayerDto[]>;
  clashTeam?: (teamId: string) => RiotApiResult<ClashTeamDto>;
}

function fakeClient(overrides: ClientOverrides = {}) {
  const reject = () => Promise.reject(new Error('not used'));
  const getAccountByRiotId = vi.fn(() =>
    Promise.resolve(overrides.account?.() ?? ok({ puuid: 'puuid-a', gameName: 'A', tagLine: 'NA1' })),
  );
  const getClashPlayersByPuuid = vi.fn(() => Promise.resolve(overrides.clashPlayers?.() ?? ok([registration()])));
  const getClashTeam = vi.fn((_platform: string, teamId: string) =>
    Promise.resolve(overrides.clashTeam?.(teamId) ?? ok(team({ id: teamId }))),
  );
  const client = {
    getAccountByRiotId,
    getRegionByPuuid: reject,
    getSummonerByPuuid: reject,
    getLeagueEntriesByPuuid: reject,
    getMatchIdsByPuuid: reject,
    getMatchById: reject,
    getMatchTimeline: reject,
    getActiveGameByPuuid: reject,
    getAccountByPuuid: reject,
    getChampionMastery: reject,
    getClashPlayersByPuuid,
    getClashTeam,
    getClashTournamentsByTeam: reject,
    getChampionMasteryTop: reject,
  } as unknown as RiotApiClient;
  return { client, getAccountByRiotId, getClashPlayersByPuuid, getClashTeam };
}

function makeOrchestrator(overrides: Partial<ScoutingOrchestratorOptions> & { client: RiotApiClient }) {
  return createScoutingOrchestrator({
    cache: createInMemoryCacheStore({ now: () => 1_000 }),
    now: () => 1_000,
    regionResolver: RESOLVED,
    rosterEnricher: PASSTHROUGH_ENRICHER,
    ...overrides,
  });
}

const RIOT_ID = { gameName: 'A', tagLine: 'NA1' };

describe('createScoutingOrchestrator.scout', () => {
  // Feature: clash-scouting, Property 1: No active Clash registration is a state and never an error
  it('returns not_registered (a state, not an error) for an empty registration array', async () => {
    const { client } = fakeClient({ clashPlayers: () => ok([]) });
    expect(await makeOrchestrator({ client }).scout(RIOT_ID)).toEqual({ kind: 'not_registered' });
  });

  it('returns not_registered for a stale registration whose team 404s', async () => {
    const { client } = fakeClient({ clashTeam: () => notFound() });
    expect(await makeOrchestrator({ client }).scout(RIOT_ID)).toEqual({ kind: 'not_registered' });
  });

  it('returns a team picker for multiple registrations with no teamId (Requirement 1.5)', async () => {
    const { client } = fakeClient({
      clashPlayers: () => ok([registration({ teamId: 'team-1' }), registration({ teamId: 'team-2' })]),
    });
    const result = await makeOrchestrator({ client }).scout(RIOT_ID);
    expect(result.kind).toBe('multiple_teams');
    if (result.kind !== 'multiple_teams') return;
    expect(result.teams.map((t) => t.id)).toEqual(['team-1', 'team-2']);
  });

  it('resolves a specific team by teamId even with multiple registrations', async () => {
    const { client, getClashTeam } = fakeClient({
      clashPlayers: () => ok([registration({ teamId: 'team-1' }), registration({ teamId: 'team-2' })]),
    });
    const result = await makeOrchestrator({ client }).scout(RIOT_ID, 'team-2');
    expect(result.kind).toBe('report');
    expect(getClashTeam).toHaveBeenCalledWith('na1', 'team-2');
  });

  it('assembles a report with roster cards and insights for a single registration', async () => {
    const { client } = fakeClient();
    const result = await makeOrchestrator({ client }).scout(RIOT_ID);
    expect(result.kind).toBe('report');
    if (result.kind !== 'report') return;
    expect(result.report.team).toMatchObject({ id: 'team-1', name: 'Test Team', captainPuuid: 'puuid-a' });
    expect(result.report.roster.map((card) => card.puuid)).toEqual(['puuid-a', 'puuid-b']);
    expect(result.report.roster.find((card) => card.puuid === 'puuid-a')?.isCaptain).toBe(true);
    expect(result.report.insights).toEqual({ banRecommendations: [], positionMismatches: [], stackCohesion: 0 });
  });

  // Feature: clash-scouting, Property 2 (partial — full property test 5.3 deferred)
  it('never calls a tournaments endpoint on the request path; report has tournament: null on a cold cache', async () => {
    const { client } = fakeClient();
    const result = await makeOrchestrator({ client }).scout(RIOT_ID);
    expect(result.kind).toBe('report');
    if (result.kind !== 'report') return;
    expect(result.report.tournament).toBeNull();
  });

  it('reads a fresh tournamentSchedule entry and attaches the matching tournament', async () => {
    const cache = createInMemoryCacheStore({ now: () => 1_000 });
    const schedule: ClashTournamentDto[] = [
      { id: 500, themeId: 1, nameKey: 'clash_theme', nameKeySecondary: 'clash_theme_secondary', schedule: [] },
    ];
    await cache.set({ endpoint: 'tournamentSchedule', routingValue: 'na1', params: {} }, schedule, 60 * 60 * 1000);
    const { client } = fakeClient();
    const result = await makeOrchestrator({ client, cache, now: () => 1_000 }).scout(RIOT_ID);
    expect(result.kind).toBe('report');
    if (result.kind !== 'report') return;
    expect(result.report.tournament).toEqual({ id: 500, nameKey: 'clash_theme', nameKeySecondary: 'clash_theme_secondary' });
  });

  it('degrades to tournament: null for a stale tournamentSchedule entry rather than blocking (Requirement 4.4)', async () => {
    const cache = createInMemoryCacheStore({ now: () => 0 });
    const schedule: ClashTournamentDto[] = [
      { id: 500, themeId: 1, nameKey: 'clash_theme', nameKeySecondary: 'clash_theme_secondary', schedule: [] },
    ];
    await cache.set({ endpoint: 'tournamentSchedule', routingValue: 'na1', params: {} }, schedule, 60 * 60 * 1000);
    const { client } = fakeClient();
    // Advance well past the 1h TTL.
    const result = await makeOrchestrator({ client, cache, now: () => 10 * 60 * 60 * 1000 }).scout(RIOT_ID);
    expect(result.kind).toBe('report');
    if (result.kind !== 'report') return;
    expect(result.report.tournament).toBeNull();
  });

  it('maps account not-found to PLAYER_NOT_FOUND', async () => {
    const { client } = fakeClient({ account: () => notFound() });
    expect(await makeOrchestrator({ client }).scout(RIOT_ID)).toEqual({
      kind: 'error',
      code: 'PLAYER_NOT_FOUND',
      retriable: false,
    });
  });

  it('maps region-resolution outcomes through the shared error table', async () => {
    const { client } = fakeClient();
    const noAccount = makeOrchestrator({ client, regionResolver: { resolve: () => Promise.resolve({ kind: 'no_lol_account' }) } });
    expect(await noAccount.scout(RIOT_ID)).toEqual({ kind: 'error', code: 'NO_LOL_ACCOUNT', retriable: false });
  });

  it('maps a Clash-V1 players-by-puuid server error to a retriable RIOT_UNAVAILABLE', async () => {
    const { client } = fakeClient({ clashPlayers: () => ({ kind: 'server_error', status: 502 }) });
    expect(await makeOrchestrator({ client }).scout(RIOT_ID)).toEqual({
      kind: 'error',
      code: 'RIOT_UNAVAILABLE',
      retriable: true,
    });
  });
});
