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
    win: true,
    ...over,
  };
}

function sum(deltas: Map<string, number>): number {
  return [...deltas.values()].reduce((total, d) => total + d, 0);
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
    const matches = [match({ matchId: 'm1', startTimestamp: HOUR })];

    expect(computeLpDeltas(matches, checkpoints).get('m1')).toBe(18);
  });

  it('reports a negative delta for a loss', () => {
    const checkpoints = [
      checkpoint({ leaguePoints: 50, observedAt: 0 }),
      checkpoint({ leaguePoints: 32, observedAt: 2 * HOUR }),
    ];
    const matches = [match({ matchId: 'm1', startTimestamp: HOUR, win: false })];

    expect(computeLpDeltas(matches, checkpoints).get('m1')).toBe(-18);
  });

  it('never shows a positive delta on a defeat, even when the bracket net is positive (decision 1)', () => {
    const checkpoints = [
      checkpoint({ leaguePoints: 50, observedAt: 0 }),
      checkpoint({ leaguePoints: 70, observedAt: 6 * HOUR }), // net +20 across 3W + 2L
    ];
    const matches = [
      match({ matchId: 'w1', startTimestamp: 1 * HOUR, win: true }),
      match({ matchId: 'l1', startTimestamp: 2 * HOUR, win: false }),
      match({ matchId: 'w2', startTimestamp: 3 * HOUR, win: true }),
      match({ matchId: 'l2', startTimestamp: 4 * HOUR, win: false }),
      match({ matchId: 'w3', startTimestamp: 5 * HOUR, win: true }),
    ];

    const deltas = computeLpDeltas(matches, checkpoints);
    // 3W - 2L, net +20  ->  g = trunc(20 / 1) = 20  ->  wins +20, losses -20.
    expect(deltas.get('w1')).toBe(20);
    expect(deltas.get('l1')).toBe(-20);
    expect(deltas.get('l2')).toBe(-20);
    expect(sum(deltas)).toBe(20);
    for (const [, d] of deltas) {
      expect(d).not.toBeNaN();
    }
  });

  it('keeps every win non-negative and every loss non-positive, shares summing to the bracket total', () => {
    const checkpoints = [
      checkpoint({ leaguePoints: 20, observedAt: 0 }),
      checkpoint({ leaguePoints: 85, observedAt: 10 * HOUR }), // net +65 across 7W + 3L
    ];
    const matches = Array.from({ length: 10 }, (_, i) =>
      match({ matchId: `m${String(i)}`, startTimestamp: (i + 1) * HOUR, win: i < 7 }),
    );

    const deltas = computeLpDeltas(matches, checkpoints);
    expect(sum(deltas)).toBe(65);
    for (const [id, d] of deltas) {
      if (Number(id.slice(1)) < 7) {
        expect(d).toBeGreaterThanOrEqual(0);
      } else {
        expect(d).toBeLessThanOrEqual(0);
      }
    }
  });

  it('splits same-result matches between the same two checkpoints (decision 1)', () => {
    const checkpoints = [
      checkpoint({ leaguePoints: 50, observedAt: 0 }),
      checkpoint({ leaguePoints: 68, observedAt: 4 * HOUR }),
    ];
    const matches = [
      match({ matchId: 'm1', startTimestamp: HOUR, win: true }),
      match({ matchId: 'm2', startTimestamp: 2 * HOUR, win: true }),
    ];

    // Two wins, +18: g = trunc(18 / 2) = 9.
    const deltas = computeLpDeltas(matches, checkpoints);
    expect(deltas.get('m1')).toBe(9);
    expect(deltas.get('m2')).toBe(9);
  });

  it('splits an unevenly-divisible delta so the shares still sum to the exact total, remainder to the earliest matches', () => {
    const checkpoints = [
      checkpoint({ leaguePoints: 50, observedAt: 0 }),
      checkpoint({ leaguePoints: 67, observedAt: 6 * HOUR }), // total delta = 17, across 3 wins
    ];
    const matches = [
      match({ matchId: 'm1', startTimestamp: HOUR, win: true }), // earliest
      match({ matchId: 'm2', startTimestamp: 2 * HOUR, win: true }),
      match({ matchId: 'm3', startTimestamp: 3 * HOUR, win: true }), // latest
    ];

    // 3 wins, +17: g = trunc(17 / 3) = 5, leftover 2 -> the two earliest wins get the +1 bump.
    const deltas = computeLpDeltas(matches, checkpoints);
    expect(deltas.get('m1')).toBe(6);
    expect(deltas.get('m2')).toBe(6);
    expect(deltas.get('m3')).toBe(5);
    expect(sum(deltas)).toBe(17);
  });

  it('splits an unevenly-divisible negative delta the same way', () => {
    const checkpoints = [
      checkpoint({ leaguePoints: 50, observedAt: 0 }),
      checkpoint({ leaguePoints: 33, observedAt: 6 * HOUR }), // total delta = -17, across 3 losses
    ];
    const matches = [
      match({ matchId: 'm1', startTimestamp: HOUR, win: false }),
      match({ matchId: 'm2', startTimestamp: 2 * HOUR, win: false }),
      match({ matchId: 'm3', startTimestamp: 3 * HOUR, win: false }),
    ];

    const deltas = computeLpDeltas(matches, checkpoints);
    expect(deltas.get('m1')).toBe(-6);
    expect(deltas.get('m2')).toBe(-6);
    expect(deltas.get('m3')).toBe(-5);
    expect(sum(deltas)).toBe(-17);
  });

  it('is empty when there is only one checkpoint for the queue (no bracket possible)', () => {
    expect(computeLpDeltas([match({ startTimestamp: HOUR })], [checkpoint({ observedAt: 0 })]).size).toBe(0);
  });

  it('never attributes a delta to a match outside every checkpoint window', () => {
    const checkpoints = [checkpoint({ observedAt: 0 }), checkpoint({ observedAt: HOUR })];
    const matches = [match({ startTimestamp: 10 * HOUR })];
    expect(computeLpDeltas(matches, checkpoints).size).toBe(0);
  });

  it('never attributes a delta to a normal or ARAM match (decision 3)', () => {
    const checkpoints = [checkpoint({ observedAt: 0 }), checkpoint({ leaguePoints: 68, observedAt: 2 * HOUR })];
    expect(computeLpDeltas([match({ queueType: 'normal', startTimestamp: HOUR })], checkpoints).size).toBe(0);
  });

  it('excludes a remake (shorter than REMAKE_MAX_DURATION_SECONDS) from every bracket', () => {
    const checkpoints = [
      checkpoint({ leaguePoints: 50, observedAt: 0 }),
      checkpoint({ leaguePoints: 68, observedAt: 4 * HOUR }),
    ];
    const matches = [
      match({ matchId: 'real', startTimestamp: HOUR, durationSeconds: 1_800, win: true }),
      match({ matchId: 'remake', startTimestamp: 2 * HOUR, durationSeconds: 180, win: false }),
    ];

    const deltas = computeLpDeltas(matches, checkpoints);
    expect(deltas.has('remake')).toBe(false);
    expect(deltas.get('real')).toBe(18);
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
      match({ matchId: 'flex', queueType: 'ranked flex', startTimestamp: HOUR, win: false }),
    ];

    const deltas = computeLpDeltas(matches, checkpoints);
    expect(deltas.get('solo')).toBe(18);
    expect(deltas.get('flex')).toBe(-5);
  });

  it('is empty for no matches or no checkpoints', () => {
    expect(computeLpDeltas([], [checkpoint()]).size).toBe(0);
    expect(computeLpDeltas([match()], []).size).toBe(0);
  });

  describe('with checkpoint win/loss counts (decision 1)', () => {
    it('uses the checkpoint W/L split for the per-game magnitude', () => {
      const checkpoints = [
        checkpoint({ leaguePoints: 50, wins: 100, losses: 100, observedAt: 0 }),
        checkpoint({ leaguePoints: 70, wins: 103, losses: 102, observedAt: 6 * HOUR }), // 3W 2L, +20
      ];
      const matches = [
        match({ matchId: 'w1', startTimestamp: 1 * HOUR, win: true }),
        match({ matchId: 'l1', startTimestamp: 2 * HOUR, win: false }),
        match({ matchId: 'w2', startTimestamp: 3 * HOUR, win: true }),
        match({ matchId: 'l2', startTimestamp: 4 * HOUR, win: false }),
        match({ matchId: 'w3', startTimestamp: 5 * HOUR, win: true }),
      ];

      const deltas = computeLpDeltas(matches, checkpoints);
      // g = trunc(20 / (3 - 2)) = 20. All games visible -> sums to +20.
      expect(deltas.get('w1')).toBe(20);
      expect(deltas.get('l1')).toBe(-20);
      expect(sum(deltas)).toBe(20);
    });

    it('does not force the visible shares to sum to the delta when games are missing', () => {
      const checkpoints = [
        checkpoint({ leaguePoints: 20, wins: 100, losses: 100, observedAt: 0 }),
        checkpoint({ leaguePoints: 85, wins: 110, losses: 100, observedAt: 10 * HOUR }), // 10W 0L, +65
      ];
      // Only 3 of the 10 wins are in the fetched window.
      const matches = [
        match({ matchId: 'a', startTimestamp: 1 * HOUR, win: true }),
        match({ matchId: 'b', startTimestamp: 2 * HOUR, win: true }),
        match({ matchId: 'c', startTimestamp: 3 * HOUR, win: true }),
      ];

      const deltas = computeLpDeltas(matches, checkpoints);
      // g = trunc(65 / 10) = 6 per win; each visible win shows +6, not +21.
      expect(deltas.get('a')).toBe(6);
      expect(deltas.get('b')).toBe(6);
      expect(deltas.get('c')).toBe(6);
      expect(sum(deltas)).toBe(18); // deliberately not 65
    });

    it('skips a bracket that is pure LP decay (zero games, non-zero delta)', () => {
      const checkpoints = [
        checkpoint({ leaguePoints: 75, wins: 200, losses: 150, observedAt: 0 }),
        checkpoint({ leaguePoints: 60, wins: 200, losses: 150, observedAt: 4 * HOUR }), // -15 LP, 0 games
      ];
      const matches = [match({ matchId: 'x', startTimestamp: HOUR, win: false })];

      expect(computeLpDeltas(matches, checkpoints).size).toBe(0);
    });

    it('falls back to visible-match counting when a season reset drops the W/L count', () => {
      const checkpoints = [
        checkpoint({ leaguePoints: 50, wins: 300, losses: 280, observedAt: 0 }),
        checkpoint({ leaguePoints: 32, wins: 2, losses: 3, observedAt: 4 * HOUR }), // counts went backwards
      ];
      const matches = [match({ matchId: 'm', startTimestamp: HOUR, win: false })];

      // Fallback: one visible loss, D = -18 -> -18.
      expect(computeLpDeltas(matches, checkpoints).get('m')).toBe(-18);
    });
  });
});
