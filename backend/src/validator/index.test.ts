import { describe, it, expect } from 'vitest';
import { validateRiotId } from './index';

describe('validateRiotId', () => {
  // Requirement 1.2: exactly one '#', both trimmed parts non-empty -> accepted
  it('accepts a well-formed Riot ID and returns the parsed parts', () => {
    expect(validateRiotId('Faker#KR1')).toEqual({
      ok: true,
      riotId: { gameName: 'Faker', tagLine: 'KR1' },
    });
  });

  it('accepts an untrimmed but otherwise valid value and returns trimmed parts', () => {
    expect(validateRiotId('  Faker  #  KR1  ')).toEqual({
      ok: true,
      riotId: { gameName: 'Faker', tagLine: 'KR1' },
    });
  });

  // Requirement 1.3: not exactly one '#'
  it('rejects a value with no # as MISSING_HASH', () => {
    expect(validateRiotId('Faker')).toEqual({ ok: false, errorCode: 'MISSING_HASH' });
  });

  it('rejects an empty string as MISSING_HASH', () => {
    expect(validateRiotId('')).toEqual({ ok: false, errorCode: 'MISSING_HASH' });
  });

  it('rejects a value with more than one # as MULTIPLE_HASH', () => {
    expect(validateRiotId('Faker#KR#1')).toEqual({ ok: false, errorCode: 'MULTIPLE_HASH' });
  });

  // Requirement 1.4: empty or whitespace-only parts
  it('rejects an empty gameName as EMPTY_PART', () => {
    expect(validateRiotId('#KR1')).toEqual({ ok: false, errorCode: 'EMPTY_PART' });
  });

  it('rejects an empty tagLine as EMPTY_PART', () => {
    expect(validateRiotId('Faker#')).toEqual({ ok: false, errorCode: 'EMPTY_PART' });
  });

  it('rejects a whitespace-only gameName as EMPTY_PART', () => {
    expect(validateRiotId('   #KR1')).toEqual({ ok: false, errorCode: 'EMPTY_PART' });
  });

  it('rejects a whitespace-only tagLine as EMPTY_PART', () => {
    expect(validateRiotId('Faker# \t ')).toEqual({ ok: false, errorCode: 'EMPTY_PART' });
  });

  // Requirement 1.5: length constraints, measured on the trimmed values
  it('accepts a gameName of exactly 16 characters', () => {
    const gameName = 'A'.repeat(16);
    expect(validateRiotId(`${gameName}#KR1`)).toEqual({
      ok: true,
      riotId: { gameName, tagLine: 'KR1' },
    });
  });

  it('rejects a gameName of 17 characters as GAME_NAME_TOO_LONG', () => {
    expect(validateRiotId(`${'A'.repeat(17)}#KR1`)).toEqual({
      ok: false,
      errorCode: 'GAME_NAME_TOO_LONG',
    });
  });

  it('accepts a tagLine of exactly 5 characters', () => {
    const tagLine = 'B'.repeat(5);
    expect(validateRiotId(`Faker#${tagLine}`)).toEqual({
      ok: true,
      riotId: { gameName: 'Faker', tagLine },
    });
  });

  it('rejects a tagLine of 6 characters as TAG_LINE_TOO_LONG', () => {
    expect(validateRiotId(`Faker#${'B'.repeat(6)}`)).toEqual({
      ok: false,
      errorCode: 'TAG_LINE_TOO_LONG',
    });
  });

  // Error precedence: gameName length violation is reported before tagLine length violation
  it('reports GAME_NAME_TOO_LONG when both length rules are violated', () => {
    expect(validateRiotId(`${'A'.repeat(17)}#${'B'.repeat(6)}`)).toEqual({
      ok: false,
      errorCode: 'GAME_NAME_TOO_LONG',
    });
  });

  // Error precedence: hash-count checks precede part-level checks
  it('reports MULTIPLE_HASH even when parts would also be invalid', () => {
    expect(validateRiotId('##')).toEqual({ ok: false, errorCode: 'MULTIPLE_HASH' });
  });
});
