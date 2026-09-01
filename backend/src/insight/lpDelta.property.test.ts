/**
 * Property test for `computeLpDeltas`' core correctness guarantee: every
 * bracket's reported deltas sum to exactly the observed ordinal change,
 * however many matches share that bracket (decision 1's even-split
 * approximation, amended 2026-09-01).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeLpDeltas, rankOrdinalOf, type LpDeltaCheckpoint, type LpDeltaMatch } from './lpDelta';

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
  durationSeconds: fc.integer({ min: 600, max: 3_000 }),
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
          const byBracket = new Map<string, { before: LpDeltaCheckpoint; after: LpDeltaCheckpoint; matchIds: string[] }>();
          for (const match of uniqueMatches) {
            const endTimestamp = match.startTimestamp + match.durationSeconds * 1000;
            const bracket = bracketFor(endTimestamp, sortedCheckpoints);
            if (bracket === undefined) {
              expect(deltas.has(match.matchId)).toBe(false);
              continue;
            }
            const key = `${String(bracket.before.observedAt)}:${String(bracket.after.observedAt)}`;
            const existing = byBracket.get(key);
            if (existing === undefined) {
              byBracket.set(key, { ...bracket, matchIds: [match.matchId] });
            } else {
              existing.matchIds.push(match.matchId);
            }
          }

          for (const { before, after, matchIds } of byBracket.values()) {
            const totalDelta = rankOrdinalOf(after) - rankOrdinalOf(before);
            let sum = 0;
            for (const matchId of matchIds) {
              const delta = deltas.get(matchId);
              expect(delta).toBeDefined();
              sum += delta ?? 0;
            }
            expect(sum).toBe(totalDelta);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
