import { describe, expect, it } from 'vitest';
import { MAX_SUGGESTIONS, MIN_QUERY_LENGTH, isAnswerableSuggestionQuery, namePrefixOf } from './suggestions';

/**
 * Pure autocomplete-query rules. Asserted against the literal values in
 * specs/autofill-search/ design.md, not against the backend constants — that is
 * what catches a drift between the two copies. `parity.test.ts` additionally
 * cross-checks the backend source.
 */

describe('autofill-search query constants', () => {
  it('matches the documented values', () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(MAX_SUGGESTIONS).toBe(8);
  });
});

describe('isAnswerableSuggestionQuery — Requirement 1.5', () => {
  it('accepts a prefix of at least MIN_QUERY_LENGTH with no #', () => {
    expect(isAnswerableSuggestionQuery('fa')).toBe(true);
    expect(isAnswerableSuggestionQuery('faker')).toBe(true);
  });

  it('rejects a query shorter than MIN_QUERY_LENGTH', () => {
    expect(isAnswerableSuggestionQuery('')).toBe(false);
    expect(isAnswerableSuggestionQuery('f')).toBe(false);
  });

  it('rejects a query that already contains a #', () => {
    expect(isAnswerableSuggestionQuery('faker#')).toBe(false);
    expect(isAnswerableSuggestionQuery('faker#kr1')).toBe(false);
  });
});

describe('namePrefixOf', () => {
  it('returns the trimmed text before any #', () => {
    expect(namePrefixOf('Faker')).toBe('Faker');
    expect(namePrefixOf('Faker#KR1')).toBe('Faker');
    expect(namePrefixOf('  Faker  ')).toBe('Faker');
    expect(namePrefixOf('  Faker  #KR1')).toBe('Faker');
    expect(namePrefixOf('#KR1')).toBe('');
  });
});
