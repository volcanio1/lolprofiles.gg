import { describe, expect, it } from 'vitest';
import { relativeAge } from './format';

const NOW = 1_700_000_000_000;
const m = 60 * 1000;
const h = 60 * m;
const d = 24 * h;

describe('relativeAge — autofill-search Requirement 10.2', () => {
  it.each([
    [NOW, 'just now'],
    [NOW - 10 * 1000, 'just now'],
    [NOW - 90 * 1000, '1m ago'],
    [NOW - 5 * m, '5m ago'],
    [NOW - 3 * h, '3h ago'],
    [NOW - 2 * d, '2d ago'],
    [NOW + 5 * m, 'just now'], // a future timestamp never reads negative
  ])('relativeAge(%i) is %s', (from, expected) => {
    expect(relativeAge(from, NOW)).toBe(expected);
  });
});
