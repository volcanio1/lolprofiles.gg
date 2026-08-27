import { describe, expect, it } from 'vitest';

import { extractSkillOrder, reconcile, replayShopEvents, type TimelineEventDto } from './buildPath';
import { EMPTY_ITEM_BUILD, type ItemBuild } from './stats';

const SLOT = 1;

function purchased(itemId: number, timestamp: number, participantId = SLOT): TimelineEventDto {
  return { type: 'ITEM_PURCHASED', timestamp, participantId, itemId };
}
function sold(itemId: number, timestamp: number, participantId = SLOT): TimelineEventDto {
  return { type: 'ITEM_SOLD', timestamp, participantId, itemId };
}
function destroyed(itemId: number, timestamp: number, participantId = SLOT): TimelineEventDto {
  return { type: 'ITEM_DESTROYED', timestamp, participantId, itemId };
}
function undo(beforeId: number, afterId: number, timestamp: number, participantId = SLOT): TimelineEventDto {
  return { type: 'ITEM_UNDO', timestamp, participantId, beforeId, afterId };
}

function build(items: number[], trinket = 0): ItemBuild {
  const [i0 = 0, i1 = 0, i2 = 0, i3 = 0, i4 = 0, i5 = 0] = items;
  return { items: [i0, i1, i2, i3, i4, i5], trinket };
}

describe('replayShopEvents', () => {
  it('produces an ordered build path from purchases, ignoring other slots', () => {
    const events = [purchased(1055, 10_000), purchased(9999, 5_000, 2), purchased(3006, 60_000)];
    const { buildPath } = replayShopEvents(events, SLOT);
    expect(buildPath).toEqual([
      { itemId: 1055, timestamp: 10_000 },
      { itemId: 3006, timestamp: 60_000 },
    ]);
  });

  it('drops an undone purchase entirely, matching undos to actions by item id', () => {
    const events = [purchased(1036, 10_000), purchased(2055, 20_000), undo(2055, 0, 21_000)];
    const { buildPath, finalInventory } = replayShopEvents(events, SLOT);
    expect(buildPath).toEqual([{ itemId: 1036, timestamp: 10_000 }]);
    expect(finalInventory).toEqual([1036]);
  });

  it('keeps a sold item in the build path with its buy time and its later sell time', () => {
    const events = [purchased(1055, 10_000), purchased(1038, 20_000), sold(1055, 30_000)];
    const { buildPath, finalInventory } = replayShopEvents(events, SLOT);
    expect(buildPath).toEqual([
      { itemId: 1055, timestamp: 10_000, soldAt: 30_000 },
      { itemId: 1038, timestamp: 20_000 },
    ]);
    expect(finalInventory).toEqual([1038]);
  });

  it('attributes a sell to the most recent unsold identical purchase, with the sell timestamp', () => {
    const events = [purchased(2055, 10_000), purchased(2055, 20_000), sold(2055, 30_000)];
    const { buildPath } = replayShopEvents(events, SLOT);
    expect(buildPath).toEqual([
      { itemId: 2055, timestamp: 10_000 },
      { itemId: 2055, timestamp: 20_000, soldAt: 30_000 },
    ]);
  });

  it('un-flags a sold item when the sell is undone', () => {
    const events = [purchased(1055, 10_000), sold(1055, 20_000), undo(0, 1055, 21_000)];
    const { buildPath, finalInventory } = replayShopEvents(events, SLOT);
    expect(buildPath).toEqual([{ itemId: 1055, timestamp: 10_000 }]);
    expect(finalInventory).toEqual([1055]);
  });

  it('leaves a destroyed item in the build path but out of the inventory', () => {
    const events = [purchased(1036, 10_000), purchased(1037, 15_000), destroyed(1036, 20_000), destroyed(1037, 20_000), purchased(3078, 20_000)];
    const { buildPath, finalInventory } = replayShopEvents(events, SLOT);
    expect(buildPath.map((e) => e.itemId)).toEqual([1036, 1037, 3078]);
    expect(finalInventory).toEqual([3078]);
  });
});

describe('extractSkillOrder', () => {
  function skill(slot: number, timestamp: number, participantId = SLOT): TimelineEventDto {
    return { type: 'SKILL_LEVEL_UP', timestamp, participantId, skillSlot: slot };
  }

  it('returns the analyzed slot skill slots in time order', () => {
    const events = [
      skill(1, 29_000),
      skill(3, 15_000, 2), // other player, ignored
      skill(2, 89_000),
      skill(1, 152_000),
      skill(4, 312_000),
    ];
    expect(extractSkillOrder(events, SLOT)).toEqual([1, 2, 1, 4]);
  });

  it('skips a malformed or out-of-range skill slot', () => {
    const events = [skill(1, 1000), skill(9, 2000), { type: 'SKILL_LEVEL_UP', timestamp: 3000, participantId: SLOT } as TimelineEventDto, skill(4, 4000)];
    expect(extractSkillOrder(events, SLOT)).toEqual([1, 4]);
  });

  it('is empty when the slot leveled nothing', () => {
    expect(extractSkillOrder([skill(1, 1000, 2)], SLOT)).toEqual([]);
  });
});

describe('reconcile', () => {
  it('reconciles when the replay end-state matches the reported build', () => {
    expect(reconcile([1055, 3078], build([1055, 3078])).reconciled).toBe(true);
  });

  it('reconciles a boot that upgraded in place, even when the replay ends with no boot at all', () => {
    // S15: the tier-2 boot is destroyed on upgrade and the tier-3 is never
    // purchased, so the replay inventory has no boot while the final build
    // reports Spellslinger's Shoes (3175).
    expect(reconcile([1058], build([1058, 3175])).reconciled).toBe(true);
    expect(reconcile([3020], build([3175])).reconciled).toBe(true);
    expect(reconcile([1058, 3006], build([1058, 3172])).reconciled).toBe(true);
  });

  it('reconciles regardless of the trinket, on either side, which a replay may or may not see', () => {
    expect(reconcile([1055], { items: [1055, 0, 0, 0, 0, 0], trinket: 3364 }).reconciled).toBe(true);
    // Farsight (3363) can appear in the replay inventory as a 0-gold purchase.
    expect(reconcile([1055, 3363], { items: [1055, 0, 0, 0, 0, 0], trinket: 3363 }).reconciled).toBe(true);
  });

  it('does not reconcile a genuine discrepancy, and reports real item ids both ways', () => {
    const result = reconcile([1055, 9999], build([1055, 6673]));
    expect(result.reconciled).toBe(false);
    expect(result.missingFromReplay).toEqual([6673]);
    expect(result.unexpectedInReplay).toEqual([9999]);
  });

  it('reconciles an empty replay against an empty build', () => {
    expect(reconcile([], EMPTY_ITEM_BUILD).reconciled).toBe(true);
  });
});
