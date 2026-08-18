import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  isValidRegion,
  platformsFor,
  resolvePlatform,
  type RegionalRoutingValue,
} from './index';

/**
 * Expected mapping, transcribed independently from Requirement 5.2 rather than
 * imported from the implementation, so the property compares the module against
 * the specification instead of against itself.
 */
const EXPECTED: Record<string, string[]> = {
  americas: ['na1', 'br1', 'la1', 'la2'],
  europe: ['euw1', 'eun1', 'tr1', 'ru'],
  asia: ['kr', 'jp1'],
  sea: ['oc1'],
};

const EXPECTED_REGIONS = Object.keys(EXPECTED) as RegionalRoutingValue[];
const EXPECTED_PLATFORMS = EXPECTED_REGIONS.flatMap((region) => EXPECTED[region]);

const regionArb = fc.constantFrom(...EXPECTED_REGIONS);
const platformArb = fc.constantFrom(...EXPECTED_PLATFORMS);

type RequestedKind = 'inRegion' | 'otherRegion' | 'undefined' | 'arbitrary';

/**
 * Builds a (region, requestedPlatform) pair together with the branch it is
 * meant to exercise, so coverage of all four branches can be asserted.
 */
const caseArb = regionArb.chain((region) => {
  const inRegion = EXPECTED[region];
  const otherRegion = EXPECTED_PLATFORMS.filter((platform) => !inRegion.includes(platform));
  return fc.oneof(
    fc.constantFrom(...inRegion).map((requested) => ({
      region,
      requested: requested as string | undefined,
      kind: 'inRegion' as RequestedKind,
    })),
    fc.constantFrom(...otherRegion).map((requested) => ({
      region,
      requested: requested as string | undefined,
      kind: 'otherRegion' as RequestedKind,
    })),
    fc.constant({ region, requested: undefined as string | undefined, kind: 'undefined' as RequestedKind }),
    fc.string({ maxLength: 10 }).map((requested) => ({
      region,
      requested: requested as string | undefined,
      kind: 'arbitrary' as RequestedKind,
    })),
  );
});

describe('Region Router properties', () => {
  // Feature: lolprofiles-gg, Property 3: Region-to-platform mapping is closed and consistently applied
  // **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**
  it('maps each region to exactly its documented platforms, keeps regions disjoint, and resolves platforms consistently', () => {
    // (a) every supported region returns exactly its documented platform list
    fc.assert(
      fc.property(regionArb, (region) => {
        expect(isValidRegion(region)).toBe(true);
        expect([...platformsFor(region)]).toEqual(EXPECTED[region]);
      }),
      { numRuns: 100 },
    );

    // (b) membership in one region's list implies non-membership in every other
    fc.assert(
      fc.property(platformArb, (platform) => {
        const owning = EXPECTED_REGIONS.filter((region) => EXPECTED[region].includes(platform));
        expect(owning).toHaveLength(1);
        for (const region of EXPECTED_REGIONS) {
          const isMember = (platformsFor(region) as readonly string[]).includes(platform);
          expect(isMember).toBe(region === owning[0]);
        }
      }),
      { numRuns: 100 },
    );

    // (c) resolvePlatform returns the requested platform iff it is in-region,
    //     otherwise the region's first listed platform
    const branchCounts: Record<RequestedKind, number> = {
      inRegion: 0,
      otherRegion: 0,
      undefined: 0,
      arbitrary: 0,
    };

    fc.assert(
      fc.property(caseArb, ({ region, requested, kind }) => {
        branchCounts[kind] += 1;

        const inRegion = requested !== undefined && EXPECTED[region].includes(requested);
        const expected = inRegion ? requested : EXPECTED[region][0];

        expect(resolvePlatform(region, requested)).toBe(expected);
      }),
      { numRuns: 100 },
    );

    // Guard against degenerate coverage: every branch must have been exercised.
    expect(branchCounts.inRegion).toBeGreaterThan(0);
    expect(branchCounts.otherRegion).toBeGreaterThan(0);
    expect(branchCounts.undefined).toBeGreaterThan(0);
    expect(branchCounts.arbitrary).toBeGreaterThan(0);
  });
});
