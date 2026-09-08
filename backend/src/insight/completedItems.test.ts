import { describe, it, expect } from 'vitest';
import {
  BOOT_ITEM_IDS,
  COMPLETED_ITEMS_DDRAGON_VERSION,
  COMPLETED_ITEM_IDS,
  isCompletedItemId,
} from './completedItems';

describe('completed-item set', () => {
  it('tracks the pinned Data Dragon release', () => {
    expect(COMPLETED_ITEMS_DDRAGON_VERSION).toBe('16.17.1');
  });

  it('holds a plausible number of SR completed items', () => {
    expect(COMPLETED_ITEM_IDS.size).toBeGreaterThan(80);
    expect(COMPLETED_ITEM_IDS.size).toBeLessThan(200);
  });

  it('recognises legendary items and finished boots', () => {
    expect(isCompletedItemId(3031)).toBe(true); // Infinity Edge
    expect(isCompletedItemId(6672)).toBe(true); // Kraken Slayer
    expect(isCompletedItemId(3089)).toBe(true); // Rabadon's Deathcap
    expect(isCompletedItemId(3172)).toBe(true); // Gunmetal Greaves (tier-3 boot)
  });

  it('rejects components, starters, consumables and wards', () => {
    expect(isCompletedItemId(1038)).toBe(false); // B.F. Sword (component)
    expect(isCompletedItemId(1052)).toBe(false); // Amplifying Tome (component)
    expect(isCompletedItemId(1054)).toBe(false); // Doran's Shield
    expect(isCompletedItemId(1055)).toBe(false); // Doran's Blade
    expect(isCompletedItemId(2003)).toBe(false); // Health Potion
    expect(isCompletedItemId(3340)).toBe(false); // Stealth Ward (trinket)
    expect(isCompletedItemId(0)).toBe(false); // empty slot
  });

  it('rejects the current-season tier-2 boots (they build into tier-3 now)', () => {
    expect(isCompletedItemId(3006)).toBe(false); // Berserker's Greaves — a component this season
    expect(isCompletedItemId(3020)).toBe(false); // Sorcerer's Shoes
  });

  it('every boot id is also a completed item', () => {
    for (const id of BOOT_ITEM_IDS) {
      expect(COMPLETED_ITEM_IDS.has(id)).toBe(true);
    }
  });
});
