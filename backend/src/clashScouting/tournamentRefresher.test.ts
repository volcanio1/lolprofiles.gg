import { describe, expect, it, vi } from 'vitest';
import { createInMemoryCacheStore } from '../cache';
import type { RiotApiResult } from '../riotApiClient';
import { createTournamentRefresher, type RepeatingScheduler } from './tournamentRefresher';
import type { ClashTournamentDto } from './types';
import type { ClashTournamentSource } from './tournamentSource';

const TOURNAMENTS: ClashTournamentDto[] = [
  { id: 1, themeId: 1, nameKey: 'cup', nameKeySecondary: 'day1', schedule: [] },
];

/** A scheduler that captures the tick callback so a test can fire it by hand. */
function manualScheduler() {
  let tick: (() => void) | null = null;
  const cancel = vi.fn();
  const schedule: RepeatingScheduler = (_ms, run) => {
    tick = run;
    return cancel;
  };
  return { schedule, fire: () => tick?.(), cancel };
}

function makeSource(impl?: () => RiotApiResult<ClashTournamentDto[]>): ClashTournamentSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getClashTournaments: (platform) => {
      calls.push(platform);
      return Promise.resolve(impl?.() ?? { kind: 'ok', data: TOURNAMENTS });
    },
  };
}

describe('createTournamentRefresher', () => {
  it('refreshes immediately on start and writes the schedule into the cache', async () => {
    const source = makeSource();
    const cache = createInMemoryCacheStore({ now: () => 1_000 });
    const refresher = createTournamentRefresher({
      source,
      cache,
      platforms: ['na1', 'euw1'],
      now: () => 1_000,
      schedule: manualScheduler().schedule,
    });

    refresher.start(1000);
    await vi.waitFor(async () => {
      const entry = await cache.get<ClashTournamentDto[]>({
        endpoint: 'tournamentSchedule',
        routingValue: 'na1',
        params: {},
      });
      expect(entry?.value).toEqual(TOURNAMENTS);
    });
    expect(source.calls).toEqual(['na1', 'euw1']);
  });

  it('does not refresh more often than once per interval (Requirement 4.2)', async () => {
    const source = makeSource();
    let clock = 0;
    const scheduler = manualScheduler();
    const refresher = createTournamentRefresher({
      source,
      cache: createInMemoryCacheStore({ now: () => clock }),
      platforms: ['na1'],
      now: () => clock,
      schedule: scheduler.schedule,
    });

    refresher.start(5_000);
    await vi.waitFor(() => expect(source.calls).toHaveLength(1));

    clock = 4_000; // too soon
    scheduler.fire();
    expect(source.calls).toHaveLength(1);

    clock = 5_000; // interval elapsed
    scheduler.fire();
    await vi.waitFor(() => expect(source.calls).toHaveLength(2));
  });

  it('keeps the previous cache entry when a refresh fails', async () => {
    let result: RiotApiResult<ClashTournamentDto[]> = { kind: 'ok', data: TOURNAMENTS };
    const source = makeSource(() => result);
    let clock = 0;
    const cache = createInMemoryCacheStore({ now: () => clock });
    const scheduler = manualScheduler();
    const refresher = createTournamentRefresher({
      source,
      cache,
      platforms: ['na1'],
      now: () => clock,
      schedule: scheduler.schedule,
    });

    refresher.start(1_000);
    await vi.waitFor(async () =>
      expect(
        (await cache.get({ endpoint: 'tournamentSchedule', routingValue: 'na1', params: {} }))?.value,
      ).toEqual(TOURNAMENTS),
    );

    result = { kind: 'server_error', status: 502 };
    clock = 1_000;
    scheduler.fire();
    await vi.waitFor(() => expect(source.calls).toHaveLength(2));

    const entry = await cache.get({ endpoint: 'tournamentSchedule', routingValue: 'na1', params: {} });
    expect(entry?.value).toEqual(TOURNAMENTS); // unchanged
  });

  it('stop() cancels the scheduled refresh', () => {
    const scheduler = manualScheduler();
    const refresher = createTournamentRefresher({
      source: makeSource(),
      cache: createInMemoryCacheStore({ now: () => 0 }),
      platforms: ['na1'],
      now: () => 0,
      schedule: scheduler.schedule,
    });
    refresher.start(1_000);
    refresher.stop();
    expect(scheduler.cancel).toHaveBeenCalled();
  });
});
