import { describe, it, expect } from 'vitest';
import {
  MAX_CHAMPION_SUGGESTIONS,
  championPathFor,
  matchChampions,
  type ChampionCatalog,
} from './championSuggestions';

function indexOf(...names: string[]): ChampionCatalog {
  const champions: Record<string, { name: string; image: string }> = {};
  for (const name of names) {
    const key = name.replace(/[^A-Za-z]/g, '');
    champions[key] = { name, image: `${key}.png` };
  }
  return champions;
}

const CHAMPS = indexOf(
  'Jax',
  'Janna',
  'Jarvan IV',
  'Jhin',
  'Jinx',
  'Rammus',
  'Ahri',
  'Wukong',
);

describe('matchChampions', () => {
  it('anchored prefix match on the display name, case-insensitive', () => {
    expect(matchChampions('ja', CHAMPS).map((c) => c.name)).toEqual(['Janna', 'Jarvan IV', 'Jax']);
    expect(matchChampions('JA', CHAMPS).map((c) => c.name)).toEqual(['Janna', 'Jarvan IV', 'Jax']);
  });

  it('is a prefix match, not a substring or key match', () => {
    // "mm" appears inside Rammus but is not a prefix
    expect(matchChampions('mm', CHAMPS)).toEqual([]);
    // "Monkey" is Wukong's Champion_Key stem, not its display name
    expect(matchChampions('monkey', CHAMPS)).toEqual([]);
  });

  it('returns keys alongside names', () => {
    expect(matchChampions('wuk', CHAMPS)).toEqual([{ key: 'Wukong', name: 'Wukong' }]);
  });

  it('sorts alphabetically by display name and caps at the limit', () => {
    const many = indexOf('Ash', 'Asha', 'Ashb', 'Ashc', 'Ashd', 'Ashe', 'Ashf');
    const result = matchChampions('ash', many);
    expect(result).toHaveLength(MAX_CHAMPION_SUGGESTIONS);
    expect(result.map((c) => c.name)).toEqual(['Ash', 'Asha', 'Ashb', 'Ashc', 'Ashd']);
    expect(matchChampions('ash', many, 2).map((c) => c.name)).toEqual(['Ash', 'Asha']);
  });

  it('returns nothing for a null index', () => {
    expect(matchChampions('ja', null)).toEqual([]);
  });

  it('returns nothing when the query contains a # (a Riot ID, not a champion)', () => {
    expect(matchChampions('Jinx#NA1', CHAMPS)).toEqual([]);
  });

  it('returns nothing below MIN_QUERY_LENGTH, trimming first', () => {
    expect(matchChampions('j', CHAMPS)).toEqual([]);
    expect(matchChampions(' j ', CHAMPS)).toEqual([]);
    expect(matchChampions('  ja  ', CHAMPS).map((c) => c.name)).toEqual(['Janna', 'Jarvan IV', 'Jax']);
  });
});

describe('championPathFor', () => {
  it('is a bare path when every filter is at its default', () => {
    expect(championPathFor('Jinx')).toBe('/champion/Jinx');
    expect(championPathFor('Jinx', { role: 'ALL', rank: 'ALL', region: 'world' })).toBe('/champion/Jinx');
  });

  it('adds only the non-default filters to the query string', () => {
    expect(championPathFor('Jinx', { role: 'BOTTOM' })).toBe('/champion/Jinx?role=BOTTOM');
    expect(championPathFor('Jinx', { role: 'BOTTOM', rank: 'EMERALD_PLUS' })).toBe(
      '/champion/Jinx?role=BOTTOM&rank=EMERALD_PLUS',
    );
    expect(championPathFor('MonkeyKing', { region: 'na' })).toBe('/champion/MonkeyKing?region=na');
  });
});
