import { describe, it, expect } from 'vitest';
import {
  CHAMPION_KEYS,
  CHAMPION_KEYS_DDRAGON_VERSION,
  CHAMPION_NAMES,
  championDisplayName,
  isKnownChampionKey,
} from './championKeys';

describe('champion key set', () => {
  it('tracks the pinned Data Dragon release', () => {
    // Keep in step with backend/.env.example's DDRAGON_VERSION; regenerate with
    // `node backend/scripts/generateChampionKeys.mjs` after a version bump.
    expect(CHAMPION_KEYS_DDRAGON_VERSION).toBe('16.17.1');
  });

  it('holds a plausible number of champions', () => {
    expect(CHAMPION_KEYS.size).toBeGreaterThan(160);
    expect(CHAMPION_KEYS.size).toBeLessThan(400);
  });

  it('uses Champion_Key form, not display names', () => {
    // Requirement / Glossary: keys are URL-path-safe, no spaces or #.
    expect(isKnownChampionKey('MonkeyKing')).toBe(true);
    expect(isKnownChampionKey('Wukong')).toBe(false);
    expect(isKnownChampionKey('MissFortune')).toBe(true);
    expect(isKnownChampionKey('Miss Fortune')).toBe(false);
    for (const key of CHAMPION_KEYS) {
      expect(key).toMatch(/^[A-Za-z]+$/);
    }
  });

  it('recognises a well-known champion and rejects junk (Requirement 10.3)', () => {
    expect(isKnownChampionKey('Jinx')).toBe(true);
    expect(isKnownChampionKey('Ahri')).toBe(true);
    expect(isKnownChampionKey('NotAChampion')).toBe(false);
    expect(isKnownChampionKey('')).toBe(false);
    expect(isKnownChampionKey('jinx')).toBe(false); // case-sensitive
  });

  it('maps every key to a display name (Requirement 11.1)', () => {
    expect(CHAMPION_NAMES.size).toBe(CHAMPION_KEYS.size);
    expect(championDisplayName('MonkeyKing')).toBe('Wukong');
    expect(championDisplayName('Kaisa')).toBe("Kai'Sa");
    expect(championDisplayName('Jinx')).toBe('Jinx');
    // unknown key falls back to itself rather than throwing
    expect(championDisplayName('NotAChampion')).toBe('NotAChampion');
  });
});
