import { describe, expect, it } from 'vitest';
import { computeLpDeltas, rankOrdinalOf, type LpDeltaCheckpoint, type LpDeltaMatch } from './lpDelta';

const HOUR = 3_600_000;

function checkpoint(over: Partial<LpDeltaCheckpoint> = {}): LpDeltaCheckpoint {
  return { queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', division: 'II', leaguePoints: 50, observedAt: 0, ...over };
}

function match(over: Partial<LpDeltaMatch> = {}): LpDeltaMatch {
  return {
    matchId: 'm1',
    queueType: 'ranked solo/duo',
    startTimestamp: HOUR,
    durationSeconds: 1_800, // ends at startTimestamp + 30min
    ...over,
  };
}

describe('rankOrdinalOf', () => {
  it('increases within a division as LP rises', () => {
    expect(rankOrdinalOf({ tier: 'GOLD', division: 'II', leaguePoints: 10 })).toBeLessThan(
      rankOrdinalOf({ tier: 'GOLD', division: 'II', leaguePoints: 90 }),
    );
  });

  it('increases across a promotion even though raw LP drops (Gold IV 90 -> Gold III 10)', () => {
    const before = rankOrdinalOf({ tier: 'GOLD', division: 'IV', leaguePoints: 90 });
    const after = rankOrdinalOf({ tier: 'GOLD', division: 'III', leaguePoints: 10 });
    expect(after).toBeGreaterThan(before);
  });

  it('Master+ has no division and is unbounded above 100 LP', () => {
    const master0 = rankOrdinalOf({ tier: 'MASTER', division: '', leaguePoints: 0 });
    const master500 = rankOrdinalOf({ tier: 'MASTER', division: '', leaguePoints: 500 });
    expect(master500 - master0).toBe(500);
  });
});

describe('computeLpDeltas', () => {
  it('attributes the exact LP delta to the one match between two adjacent checkpoints', () => {
    const checkpoints = [
      checkpoint({ leaguePoints: 50, observedAt: 0 }),
      checkpoint({ leaguePoints: 68, observedAt: 2 * HOUR }),
    ];
    const matches = [match({ matchId: 'm1', startTimestamp: HOUR, durationSeconds: 1_800 })];

    const deltas = computeLpDeltas(matches, checkpoints);
    expect(deltas.get('m1')).toBe(18);
  });

  it('reports a negative delta for a loss', () => {
    const checkpoints = [
      checkpoint({ leaguePoints: 50, observedAt: 0 }),
      checkpoint({ leaguePoints: 32, observedAt: 2 * HOUR }),
    ];
    const matches = [match({ matchId: 'm1', startTimestamp: HOUR, durationSeconds: 1_800 })];

    expect(computeLpDeltas(matches, checkpoints).get('m1')).toBe(-18);
  });

  it('splits the delta evenly across matches that fall between the same two checkpoints (decision 1)', () => {
    const checkpoints = [
      checkpoint({ leaguePoints: 50, observedAt: 0 }),
      checkpoint({ leaguePoints: 68, observedAt: 4 * HOUR }),
    ];
    const matches = [
      match({ matchId: 'm1', startTimestamp: HOUR, durationSeconds: 1_800 }),
      match({ matchId: 'm2', startTimestamp: 2 * HOUR, durationSeconds: 1_800 }),
    ];

    const deltas = computeLpDeltas(matches, checkpoints);
    expect(deltas.get('m1')).toBe(9);
    expect(deltas.get('m2')).toBe(9);
  });

  it('splits an unevenly-divisible delta so the shares still sum to the exact total, remainder to the earliest matches', () => {
    const checkpoints = [
      checkpoint({ leaguePoints: 50, observedAt: 0 }),
      checkpoint({ leaguePoints: 67, observedAt: 6 * HOUR }), // total delta = 17, across 3 matches
    ];
    const matches = [
      match({ matchId: 'm1', startTimestamp: HOUR, durationSeconds: 1_800 }), // earliest
      match({ matchId: 'm2', startTimestamp: 2 * HOUR, durationSeconds: 1_800 }),
      match({ matchId: 'm3', startTimestamp: 3 * HOUR, durationSeconds: 1_800 }), // latest
    ];

    // 17 / 3 -> base 5, remainder 2: the two earliest matches get the +1 bump.
    const deltas = computeLpDeltas(matches, checkpoints);
    expect(deltas.get('m1')).toBe(6);
    expect(deltas.get('m2')).toBe(6);
    expect(deltas.get('m3')).toBe(5);
    expect((deltas.get('m1') ?? 0) + (deltas.get('m2') ?? 0) + (deltas.get('m3') ?? 0)).toBe(17);
  });

  it('splits an unevenly-divisible negative delta the same way', () => {
    const checkpoints = [
      checkpoint({ leaguePoints: 50, observedAt: 0 }),
      checkpoint({ leaguePoints: 33, observedAt: 6 * HOUR }), // total delta = -17, across 3 matches
    ];
    const matches = [
      match({ matchId: 'm1', startTimestamp: HOUR, durationSeconds: 1_800 }),
      match({ matchId: 'm2', startTimestamp: 2 * HOUR, durationSeconds: 1_800 }),
      match({ matchId: 'm3', startTimestamp: 3 * HOUR, durationSeconds: 1_800 }),
    ];

    // -17 / 3 -> base -5 (trunc toward zero), remainder -2: the two earliest matches get the -1 bump.
    const deltas = computeLpDeltas(matches, checkpoints);
    expect(deltas.get('m1')).toBe(-6);
    expect(deltas.get('m2')).toBe(-6);
    expect(deltas.get('m3')).toBe(-5);
    expect((deltas.get('m1') ?? 0) + (deltas.get('m2') ?? 0) + (deltas.get('m3') ?? 0)).toBe(-17);
  });

  it('is empty when there is only one checkpoint for the queue (no bracket possible)', () => {
    const checkpoints = [checkpoint({ observedAt: 0 })];
    const matches = [match({ startTimestamp: HOUR })];
    expect(computeLpDeltas(matches, checkpoints).size).toBe(0);
  });

  it('never attributes a delta to a match outside every checkpoint window', () => {
    const checkpoints = [checkpoint({ observedAt: 0 }), checkpoint({ observedAt: HOUR })];
    // Match ends well after the last checkpoint.
    const matches = [match({ startTimestamp: 10 * HOUR, durationSeconds: 1_800 })];
    expect(computeLpDeltas(matches, checkpoints).size).toBe(0);
  });

  it('never attributes a delta to a normal or ARAM match (decision 3)', () => {
    const checkpoints = [checkpoint({ observedAt: 0 }), checkpoint({ leaguePoints: 68, observedAt: 2 * HOUR })];
    const matches = [match({ queueType: 'normal', startTimestamp: HOUR })];
    expect(computeLpDeltas(matches, checkpoints).size).toBe(0);
  });

  it('tracks ranked solo/duo and ranked flex independently', () => {
    const checkpoints = [
      checkpoint({ queueType: 'RANKED_SOLO_5x5', leaguePoints: 50, observedAt: 0 }),
      checkpoint({ queueType: 'RANKED_SOLO_5x5', leaguePoints: 68, observedAt: 2 * HOUR }),
      checkpoint({ queueType: 'RANKED_FLEX_SR', leaguePoints: 10, observedAt: 0 }),
      checkpoint({ queueType: 'RANKED_FLEX_SR', leaguePoints: 5, observedAt: 2 * HOUR }),
    ];
    const matches = [
      match({ matchId: 'solo', queueType: 'ranked solo/duo', startTimestamp: HOUR }),
      match({ matchId: 'flex', queueType: 'ranked flex', startTimestamp: HOUR }),
    ];

    const deltas = computeLpDeltas(matches, checkpoints);
    expect(deltas.get('solo')).toBe(18);
    expect(deltas.get('flex')).toBe(-5);
  });

  it('is empty for no matches or no checkpoints', () => {
    expect(computeLpDeltas([], [checkpoint()]).size).toBe(0);
    expect(computeLpDeltas([match()], []).size).toBe(0);
  });
});
