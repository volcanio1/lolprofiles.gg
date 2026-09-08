import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { RunePage } from '../../insight/stats';
import {
  parseItemPath,
  parseRunePage,
  parseSkillOrder,
  parseSpellPair,
  parseStartingItems,
  serializeItemPath,
  serializeRunePage,
  serializeSkillOrder,
  serializeSpellPair,
  serializeStartingItems,
} from './serialize';

const RUNES: RunePage = {
  primaryStyle: 8100,
  secondaryStyle: 8000,
  primarySelections: [8112, 8126, 8138, 8135],
  secondarySelections: [9111, 8014],
  statShards: [5008, 5008, 5001],
};

/** A Mongo field name: no `.`, no leading `$`, non-empty, no NUL. */
const MONGO_KEY = /^(?!\$)[^.\0]+$/;

describe('serialize round-trips', () => {
  it('item path', () => {
    expect(parseItemPath(serializeItemPath([3006, 3031, 3036]))).toEqual([3006, 3031, 3036]);
    expect(parseItemPath(serializeItemPath([]))).toEqual([]);
  });

  it('starting items', () => {
    expect(parseStartingItems(serializeStartingItems([1055, 2003]))).toEqual([1055, 2003]);
    expect(parseStartingItems(serializeStartingItems([]))).toEqual([]);
  });

  it('spell pair', () => {
    expect(parseSpellPair(serializeSpellPair([4, 7]))).toEqual([4, 7]);
  });

  it('skill order', () => {
    const v = { maxOrder: ['Q', 'W', 'E'] as const, perLevel: [1, 3, 2, 1, 4] };
    expect(parseSkillOrder(serializeSkillOrder(v))).toEqual(v);
    expect(parseSkillOrder(serializeSkillOrder({ maxOrder: [], perLevel: [] }))).toEqual({
      maxOrder: [],
      perLevel: [],
    });
  });

  it('rune page — deep-equals the original', () => {
    expect(parseRunePage(serializeRunePage(RUNES))).toEqual(RUNES);
  });
});

describe('every serialized key is a valid Mongo field name', () => {
  it('over random builds', () => {
    const id = fc.integer({ min: 1, max: 9999 });
    fc.assert(
      fc.property(
        fc.array(id, { maxLength: 3 }),
        fc.array(id, { maxLength: 5 }),
        fc.tuple(id, id),
        fc.record({
          primaryStyle: id,
          secondaryStyle: id,
          primarySelections: fc.array(id, { maxLength: 4 }),
          secondarySelections: fc.array(id, { maxLength: 2 }),
          statShards: fc.tuple(id, id, id),
        }),
        fc.record({
          maxOrder: fc.subarray(['Q', 'W', 'E'] as const),
          perLevel: fc.array(fc.integer({ min: 1, max: 4 }), { maxLength: 18 }),
        }),
        (itemPath, starts, spells, runes, skills) => {
          for (const key of [
            serializeItemPath(itemPath),
            serializeStartingItems(starts),
            serializeSpellPair(spells),
            serializeRunePage(runes as RunePage),
            serializeSkillOrder(skills),
          ]) {
            expect(key).toMatch(MONGO_KEY);
            expect(key.length).toBeGreaterThan(0);
          }
          // and they round-trip
          expect(parseItemPath(serializeItemPath(itemPath))).toEqual(itemPath);
          expect(parseRunePage(serializeRunePage(runes as RunePage))).toEqual(runes);
        },
      ),
      { numRuns: 200 },
    );
  });
});
