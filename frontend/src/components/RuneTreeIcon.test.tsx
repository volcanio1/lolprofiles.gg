import { describe, expect, it } from 'vitest';
import type { AssetDescription } from '../staticData/provider';
import { secondaryRuneParagraphs } from './RuneTreeIcon';

const NAMES: Record<number, string> = { 8139: 'Triumph', 8143: 'Sudden Impact', 9111: 'Presence of Mind' };
const DESCS: Record<number, AssetDescription> = {
  8139: { stats: [], paragraphs: ['Takedowns heal you and grant bonus gold.'] },
  8143: { stats: [], paragraphs: [] },
  9111: { stats: [], paragraphs: ['Restores mana on takedown.'] },
};

describe('secondaryRuneParagraphs', () => {
  it('emits one "name\\ntext" paragraph per picked rune', () => {
    expect(
      secondaryRuneParagraphs([8139, 9111], (id) => NAMES[id], (id) => DESCS[id]),
    ).toEqual(['Triumph\nTakedowns heal you and grant bonus gold.', 'Presence of Mind\nRestores mana on takedown.']);
  });

  it('falls back to just the name when a rune has no description', () => {
    expect(secondaryRuneParagraphs([8143], (id) => NAMES[id], (id) => DESCS[id])).toEqual(['Sudden Impact']);
  });

  it('drops empty rune slots', () => {
    expect(secondaryRuneParagraphs([0, 8139, 0], (id) => NAMES[id], (id) => DESCS[id])).toEqual([
      'Triumph\nTakedowns heal you and grant bonus gold.',
    ]);
  });
});
