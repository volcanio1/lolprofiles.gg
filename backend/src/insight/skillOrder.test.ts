import { describe, it, expect } from 'vitest';
import { maxOrderFromSkillOrder } from './skillOrder';

// Q W Q E Q R Q W Q W R W W E E R E  (17 level-ups)
const ORDER = [1, 2, 1, 3, 1, 4, 1, 2, 1, 2, 4, 2, 2, 3, 3, 4, 3];

/**
 * PARITY: this table is duplicated in `frontend/src/domain/parity.test.ts`.
 * If you change one, change both — the two `maxOrderFromSkillOrder`
 * implementations must agree.
 */
export const SKILL_ORDER_PARITY_CASES: { perLevel: number[]; maxOrder: string[] }[] = [
  { perLevel: ORDER, maxOrder: ['Q', 'W'] },
  { perLevel: [1, 2, 3, 4], maxOrder: [] },
  { perLevel: [3, 3, 3, 3, 3, 1, 1, 1, 1, 1], maxOrder: ['E', 'Q'] },
  { perLevel: [2, 2, 2, 2, 2], maxOrder: ['W'] },
  { perLevel: [], maxOrder: [] },
];

describe('maxOrderFromSkillOrder', () => {
  it('lists Q/W/E in the order each reached 5 points; R is never included', () => {
    expect(maxOrderFromSkillOrder(ORDER)).toEqual(['Q', 'W']); // E never hits 5
  });

  it('is empty when nothing was maxed', () => {
    expect(maxOrderFromSkillOrder([1, 2, 3, 4])).toEqual([]);
  });

  it('breaks ties by which ability reached its 5th point first', () => {
    expect(maxOrderFromSkillOrder([3, 3, 3, 3, 3, 1, 1, 1, 1, 1])).toEqual(['E', 'Q']);
  });

  it('ignores out-of-range slots', () => {
    expect(maxOrderFromSkillOrder([0, 5, 1, 1, 1, 1, 1])).toEqual(['Q']);
  });

  it('matches every parity case', () => {
    for (const { perLevel, maxOrder } of SKILL_ORDER_PARITY_CASES) {
      expect(maxOrderFromSkillOrder(perLevel)).toEqual(maxOrder);
    }
  });
});
