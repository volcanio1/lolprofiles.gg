/**
 * Property test for `computeLpDeltas`' correctness guarantees (decision 1). These
 * checkpoints carry no win/loss counts, so this exercises the fallback path:
 *  - a remake (duration below the threshold) and a match outside every checkpoint
 *    window get no delta;
 *  - every win's delta is ≥ 0, every loss's is ≤ 0;
 *  - a bracket's reported deltas sum to exactly its observed ordinal change,
 *    UNLESS the checkpoint change contradicts the results outright (only losses
 *    yet LP rose, or only wins yet LP fell) — then the unplaceable remainder is
 *    dropped and the sum lands on the result-consistent side of zero.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  computeLpDeltas,
  rankOrdinalOf,
  REMAKE_MAX_DURATION_SECONDS,
  type LpDeltaCheckpoint,
  type LpDeltaMatch,
} from './lpDelta';

const checkpointArb: fc.Arbitrary<LpDeltaCheckpoint> = fc.record({
  queueType: fc.constant('RANKED_SOLO_5x5'),
  tier: fc.constantFrom('IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND'),
  division: fc.constantFrom('IV', 'III', 'II', 'I'),
  leaguePoints: fc.integer({ min: 0, max: 100 }),
  observedAt: fc.integer({ min: 0, max: 1_000_000 }),
});

const matchArb: fc.Arbitrary<LpDeltaMatch> = fc.record({
  matchId: fc.uuid(),
  queueType: fc.constant('ranked solo/duo'),
  startTimestamp: fc.integer({ min: 0, max: 1_000_000 }),
  // Span the remake threshold so some runs generate excluded games.
  durationSeconds: fc.integer({ min: 60, max: 3_000 }),
  win: fc.boolean(),
});

/** Independent oracle: the bracket (before, after) checkpoint pair for one match's end time, or undefined. */
function bracketFor(
  endTimestamp: number,
  sortedCheckpoints: readonly LpDeltaCheckpoint[],
): { before: LpDeltaCheckpoint; after: LpDeltaCheckpoint } | undefined {
  let before: LpDeltaCheckpoint | undefined;
  let after: LpDeltaCheckpoint | undefined;
  for (const checkpoint of sortedCheckpoints) {
    if (checkpoint.observedAt <= endTimestamp) {
      before = checkpoint;
    } else if (after === undefined) {
      after = checkpoint;
    }
  }
  return before !== undefined && after !== undefined ? { before, after } : undefined;
}

describe('computeLpDeltas — every bracket sums to exactly the observed ordinal change', () => {
  it('a match outside every checkpoint window never gets a delta, and every bracket group of matches sums to its own true ordinal difference', () => {
    fc.assert(
      fc.property(
        fc.array(checkpointArb, { minLength: 0, maxLength: 8 }),
        fc.array(matchArb, { minLength: 0, maxLength: 8 }),
        (checkpoints, matches) => {
          // Distinct matchIds only — fc.uuid() already guarantees this in practice,
          // but a real collision would break the bracket-grouping below.
          const uniqueMatches = [...new Map(matches.map((m) => [m.matchId, m])).values()];
          const deltas = computeLpDeltas(uniqueMatches, checkpoints);
          const sortedCheckpoints = [...checkpoints].sort((a, b) => a.observedAt - b.observedAt);

          // Group matches by their true bracket, per the independent oracle.
          const byBracket = new Map<
            string,
            { before: LpDeltaCheckpoint; after: LpDeltaCheckpoint; matches: LpDeltaMatch[] }
          >();
          for (const match of uniqueMatches) {
            if (match.durationSeconds < REMAKE_MAX_DURATION_SECONDS) {
              expect(deltas.has(match.matchId)).toBe(false); // remake — excluded
              continue;
            }
            const endTimestamp = match.startTimestamp + match.durationSeconds * 1000;
            const bracket = bracketFor(endTimestamp, sortedCheckpoints);
            if (bracket === undefined) {
              expect(deltas.has(match.matchId)).toBe(false);
              continue;
            }
            const key = `${String(bracket.before.observedAt)}:${String(bracket.after.observedAt)}`;
            const existing = byBracket.get(key);
            if (existing === undefined) {
              byBracket.set(key, { ...bracket, matches: [match] });
            } else {
              existing.matches.push(match);
            }
          }

          for (const { before, after, matches: bracketMatches } of byBracket.values()) {
            const totalDelta = rankOrdinalOf(after) - rankOrdinalOf(before);
            let sum = 0;
            let hasWin = false;
            let hasLoss = false;
            for (const m of bracketMatches) {
              const got = deltas.get(m.matchId);
              expect(got).toBeDefined();
              const d = got ?? 0;
              // Sign follows the game result — the whole point of the revision.
              if (m.win) {
                expect(d).toBeGreaterThanOrEqual(0);
                hasWin = true;
              } else {
                expect(d).toBeLessThanOrEqual(0);
                hasLoss = true;
              }
              sum += d;
            }

            const canRepresent =
              totalDelta === 0 || (totalDelta > 0 && hasWin) || (totalDelta < 0 && hasLoss);
            if (canRepresent) {
              expect(sum).toBe(totalDelta);
            } else if (totalDelta > 0) {
              // Only losses, yet LP rose: the remainder is dropped, never chased positive.
              expect(sum).toBeLessThanOrEqual(0);
            } else {
              expect(sum).toBeGreaterThanOrEqual(0);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
