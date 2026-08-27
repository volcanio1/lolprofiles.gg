import { describe, it, expect } from 'vitest';
import type { IncludedMatch } from './stats';
import { computeRecentMatches, RECENT_MATCH_TRANSPORT_LIMIT } from './recentMatches';

const BASE_TS = 1_700_000_000_000;

function match(overrides: Partial<IncludedMatch> = {}): IncludedMatch {
  return {
    matchId: 'NA1_1',
    queueType: 'ranked solo/duo',
    startTimestamp: BASE_TS,
    durationSeconds: 1800,
    championName: 'Ahri',
    role: 'MIDDLE',
    win: true,
    kills: 5,
    deaths: 2,
    assists: 5,
    visionScore: 20,
    cs: 180,
    ...overrides,
  };
}

describe('computeRecentMatches', () => {
  it('orders matches newest first', () => {
    const matches = [
      match({ matchId: 'oldest', startTimestamp: BASE_TS }),
      match({ matchId: 'newest', startTimestamp: BASE_TS + 2000 }),
      match({ matchId: 'middle', startTimestamp: BASE_TS + 1000 }),
    ];

    expect(computeRecentMatches(matches).map((m) => m.matchId)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('caps the result at RECENT_MATCH_TRANSPORT_LIMIT', () => {
    const matches = Array.from({ length: RECENT_MATCH_TRANSPORT_LIMIT + 5 }, (_, i) =>
      match({ matchId: `m${String(i)}`, startTimestamp: BASE_TS + i }),
    );

    expect(computeRecentMatches(matches)).toHaveLength(RECENT_MATCH_TRANSPORT_LIMIT);
  });

  it('carries the opponent summary through when present', () => {
    const opponent = {
      championName: 'Zed',
      kills: 4,
      deaths: 5,
      assists: 2,
      cs: 150,
      csPerMinute: 5,
      visionScore: 15,
      build: { items: [1, 2, 3, 0, 0, 0] as const, trinket: 3340 },
    };
    const [entry] = computeRecentMatches([match({ opponent })]);

    expect(entry.opponent).toEqual(opponent);
  });

  it('reports null, not undefined, when no opponent was identified', () => {
    const [entry] = computeRecentMatches([match({ opponent: undefined })]);

    expect(entry.opponent).toBeNull();
  });

  it('defaults a missing cs to 0', () => {
    const [entry] = computeRecentMatches([match({ cs: undefined })]);

    expect(entry.cs).toBe(0);
  });

  it('defaults a missing build to all-empty slots', () => {
    const [entry] = computeRecentMatches([match({ build: undefined })]);

    expect(entry.build).toEqual({ items: [0, 0, 0, 0, 0, 0], trinket: 0 });
  });

  it('carries the build through when present', () => {
    const build = { items: [1038, 0, 0, 0, 0, 0], trinket: 3340 } as const;
    const [entry] = computeRecentMatches([match({ build })]);

    expect(entry.build).toEqual(build);
  });

  it('does not mutate its input', () => {
    const matches = [match({ matchId: 'a', startTimestamp: BASE_TS }), match({ matchId: 'b', startTimestamp: BASE_TS + 1 })];
    const copy = [...matches];

    computeRecentMatches(matches);

    expect(matches).toEqual(copy);
  });
});
