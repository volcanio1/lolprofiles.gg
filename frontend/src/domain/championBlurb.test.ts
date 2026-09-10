import { describe, expect, it } from 'vitest';
import type { ChampionProfile } from '../staticData/provider';
import { formatChampionBlurb } from './championBlurb';

function profile(overrides: Partial<ChampionProfile> = {}): ChampionProfile {
  return {
    title: 'the Loose Cannon',
    tags: ['Marksman'],
    resource: 'Mana',
    info: { attack: 9, defense: 2, magic: 4, difficulty: 6 },
    ...overrides,
  };
}

describe('formatChampionBlurb', () => {
  it('joins title, class, resource and difficulty with a middot, capitalising the title', () => {
    expect(formatChampionBlurb(profile())).toBe('The Loose Cannon · Marksman · Mana · Difficulty 6/10');
  });

  it('joins multiple class tags with a slash', () => {
    expect(formatChampionBlurb(profile({ tags: ['Fighter', 'Tank'] }))).toContain('Fighter / Tank');
  });

  it('drops the resource segment for resourceless champions ("None")', () => {
    expect(formatChampionBlurb(profile({ resource: 'None' }))).toBe(
      'The Loose Cannon · Marksman · Difficulty 6/10',
    );
  });

  it('drops any field an older cache entry did not carry', () => {
    expect(formatChampionBlurb(profile({ title: '', tags: [], info: null }))).toBe('Mana');
    expect(formatChampionBlurb(profile({ title: '', tags: [], resource: '', info: null }))).toBe('');
  });

  it('returns an empty string for a null profile', () => {
    expect(formatChampionBlurb(null)).toBe('');
  });
});
