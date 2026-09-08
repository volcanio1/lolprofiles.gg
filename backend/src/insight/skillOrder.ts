/**
 * champion-build-stats-pipeline: reduce a per-level ability stream to the ability
 * max order (task 5).
 *
 * PURE MODULE. Mirrors the frontend's `maxOrderFromSkillOrder` in
 * `frontend/src/components/SkillOrderView.tsx` — the two workspaces share no
 * code, so `frontend/src/domain/parity.test.ts` cross-checks a fixed table of
 * (input -> output) cases against this file. Keep them in step.
 */

/** slot index 0-2 -> ability key; slot 4 (R) is never ranked. */
const RANKABLE_KEYS = ['Q', 'W', 'E'] as const;
export type AbilitySlot = (typeof RANKABLE_KEYS)[number];

/**
 * Q/W/E in the order each reached 5 points — e.g. `['Q', 'W', 'E']`. An ability
 * that never hit 5 is omitted; R is never included. `perLevel` is Match-V5
 * `skillSlot` values in level order: 1 = Q, 2 = W, 3 = E, 4 = R.
 */
export function maxOrderFromSkillOrder(perLevel: readonly number[]): AbilitySlot[] {
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const maxedAtIndex: Record<number, number> = {};
  perLevel.forEach((slot, index) => {
    if (slot < 1 || slot > 4) {
      return;
    }
    counts[slot] += 1;
    if (counts[slot] === 5 && maxedAtIndex[slot] === undefined) {
      maxedAtIndex[slot] = index;
    }
  });
  return [1, 2, 3]
    .filter((slot) => maxedAtIndex[slot] !== undefined)
    .sort((a, b) => maxedAtIndex[a] - maxedAtIndex[b])
    .map((slot) => RANKABLE_KEYS[slot - 1]);
}
