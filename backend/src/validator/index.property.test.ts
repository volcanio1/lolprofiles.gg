import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { validateRiotId } from './index';

/**
 * Oracle, written independently of the implementation under test: it recomputes
 * the acceptance decision straight from the wording of Requirements 1.2-1.5
 * rather than reusing any helper from the validator module.
 */
function oracle(raw: string): { accepted: boolean; gameName?: string; tagLine?: string } {
  let hashCount = 0;
  let firstHashIndex = -1;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charAt(i) === '#') {
      hashCount += 1;
      if (firstHashIndex === -1) {
        firstHashIndex = i;
      }
    }
  }
  if (hashCount !== 1) {
    return { accepted: false };
  }

  const gameName = raw.slice(0, firstHashIndex).trim();
  const tagLine = raw.slice(firstHashIndex + 1).trim();

  const accepted =
    gameName.length >= 1 &&
    gameName.length <= 16 &&
    tagLine.length >= 1 &&
    tagLine.length <= 5;

  return accepted ? { accepted, gameName, tagLine } : { accepted: false };
}

const whitespaceArb = fc.stringOf(fc.constantFrom(' ', '\t', '\n'), { maxLength: 3 });

/** Part candidates that straddle the empty / in-range / too-long boundaries. */
const partArb = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.stringOf(fc.constantFrom(' ', '\t'), { maxLength: 3 }),
  fc.stringOf(fc.constantFrom('a', 'B', '7', '_', 'ä'), { minLength: 0, maxLength: 20 }),
);

/**
 * Structured generator: assembles a candidate from a gameName part, a tagLine
 * part, a separator repeated 0..3 times, and surrounding whitespace, so both
 * the accepting and the rejecting branches get meaningful coverage.
 */
const structuredCandidateArb = fc
  .tuple(whitespaceArb, partArb, whitespaceArb, fc.integer({ min: 0, max: 3 }), whitespaceArb, partArb, whitespaceArb)
  .map(([w1, gameName, w2, hashCount, w3, tagLine, w4]) =>
    `${w1}${gameName}${w2}${'#'.repeat(hashCount)}${w3}${tagLine}${w4}`,
  );

const candidateArb = fc.oneof(
  { weight: 1, arbitrary: fc.string({ maxLength: 30 }) },
  { weight: 1, arbitrary: fc.fullUnicodeString({ maxLength: 30 }) },
  { weight: 4, arbitrary: structuredCandidateArb },
);

describe('Riot ID Validator properties', () => {
  // Feature: lolprofiles-gg, Property 1: Riot ID validator accepts exactly well-formed inputs
  // **Validates: Requirements 1.2, 1.3, 1.4, 1.5**
  it('accepts a string if and only if it is well-formed, and returns the trimmed parts', () => {
    let acceptedCount = 0;
    let rejectedCount = 0;

    fc.assert(
      fc.property(candidateArb, (raw) => {
        const expected = oracle(raw);
        const actual = validateRiotId(raw);

        expect(actual.ok).toBe(expected.accepted);

        if (expected.accepted) {
          acceptedCount += 1;
          expect(actual.riotId).toEqual({
            gameName: expected.gameName,
            tagLine: expected.tagLine,
          });
          expect(actual.errorCode).toBeUndefined();
        } else {
          rejectedCount += 1;
          expect(actual.riotId).toBeUndefined();
          expect(actual.errorCode).toBeDefined();
        }
      }),
      { numRuns: 100 },
    );

    // Guard against degenerate coverage: both branches must have been exercised.
    expect(acceptedCount).toBeGreaterThan(0);
    expect(rejectedCount).toBeGreaterThan(0);
  });
});
