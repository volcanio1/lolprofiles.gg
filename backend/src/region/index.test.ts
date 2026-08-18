import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REGION,
  REGION_TO_PLATFORMS,
  SUPPORTED_REGIONS,
  isValidPlatform,
  isValidRegion,
  platformsFor,
  resolvePlatform,
} from './index';

describe('REGION_TO_PLATFORMS', () => {
  // Requirement 5.1: exactly four regions, nothing more
  it('contains exactly the four supported regions', () => {
    expect(Object.keys(REGION_TO_PLATFORMS)).toEqual(['americas', 'europe', 'asia', 'sea']);
  });

  // Requirement 5.2: exact membership, in the exact documented order
  it('maps each region to its exact platform list in order', () => {
    expect(REGION_TO_PLATFORMS.americas).toEqual(['na1', 'br1', 'la1', 'la2']);
    expect(REGION_TO_PLATFORMS.europe).toEqual(['euw1', 'eun1', 'tr1', 'ru']);
    expect(REGION_TO_PLATFORMS.asia).toEqual(['kr', 'jp1']);
    expect(REGION_TO_PLATFORMS.sea).toEqual(['oc1']);
  });

  it('contains exactly the eleven supported platforms with no duplicates', () => {
    const all = Object.values(REGION_TO_PLATFORMS).flat();
    expect(all).toHaveLength(11);
    expect(new Set(all).size).toBe(11);
  });
});

describe('platformsFor', () => {
  // Requirement 5.3
  it('returns the exact platform list for each region, in order', () => {
    expect(platformsFor('americas')).toEqual(['na1', 'br1', 'la1', 'la2']);
    expect(platformsFor('europe')).toEqual(['euw1', 'eun1', 'tr1', 'ru']);
    expect(platformsFor('asia')).toEqual(['kr', 'jp1']);
    expect(platformsFor('sea')).toEqual(['oc1']);
  });
});

describe('isValidRegion', () => {
  // Requirement 5.1
  it('accepts the four supported regional routing values', () => {
    expect(isValidRegion('americas')).toBe(true);
    expect(isValidRegion('europe')).toBe(true);
    expect(isValidRegion('asia')).toBe(true);
    expect(isValidRegion('sea')).toBe(true);
  });

  // Requirement 5.5: unsupported input must be rejectable by callers
  it('rejects the empty string', () => {
    expect(isValidRegion('')).toBe(false);
  });

  it('rejects platform routing values passed as regions', () => {
    expect(isValidRegion('na1')).toBe(false);
    expect(isValidRegion('NA1')).toBe(false);
  });

  it('rejects a differently-cased region because matching is case-sensitive', () => {
    expect(isValidRegion('AMERICAS')).toBe(false);
    expect(isValidRegion('Americas')).toBe(false);
  });

  it('rejects inherited Object property names', () => {
    expect(isValidRegion('toString')).toBe(false);
    expect(isValidRegion('constructor')).toBe(false);
  });
});

describe('isValidPlatform', () => {
  // Requirement 5.2
  it('accepts every platform in the mapping', () => {
    for (const platform of Object.values(REGION_TO_PLATFORMS).flat()) {
      expect(isValidPlatform(platform)).toBe(true);
    }
  });

  it('rejects values outside the mapping', () => {
    expect(isValidPlatform('')).toBe(false);
    expect(isValidPlatform('NA1')).toBe(false);
    expect(isValidPlatform('ph2')).toBe(false);
    expect(isValidPlatform('americas')).toBe(false);
  });
});

describe('resolvePlatform', () => {
  // Requirement 5.4: in-region platform is passed through unchanged
  it('returns the requested platform when it belongs to the region', () => {
    expect(resolvePlatform('americas', 'br1')).toBe('br1');
    expect(resolvePlatform('americas', 'na1')).toBe('na1');
    expect(resolvePlatform('europe', 'ru')).toBe('ru');
    expect(resolvePlatform('asia', 'jp1')).toBe('jp1');
    expect(resolvePlatform('sea', 'oc1')).toBe('oc1');
  });

  // Requirement 5.4: valid platform, wrong region -> first platform of the region
  it('falls back to the first platform when the requested platform belongs to another region', () => {
    expect(resolvePlatform('americas', 'kr')).toBe('na1');
    expect(resolvePlatform('europe', 'na1')).toBe('euw1');
    expect(resolvePlatform('asia', 'euw1')).toBe('kr');
    expect(resolvePlatform('sea', 'jp1')).toBe('oc1');
  });

  it('falls back to the first platform when no platform is requested', () => {
    expect(resolvePlatform('americas', undefined)).toBe('na1');
    expect(resolvePlatform('europe', undefined)).toBe('euw1');
    expect(resolvePlatform('asia', undefined)).toBe('kr');
    expect(resolvePlatform('sea', undefined)).toBe('oc1');
  });

  it('falls back to the first platform when the requested platform is an unknown string', () => {
    expect(resolvePlatform('americas', 'ph2')).toBe('na1');
    expect(resolvePlatform('europe', '')).toBe('euw1');
    expect(resolvePlatform('asia', 'KR')).toBe('kr');
    expect(resolvePlatform('sea', 'toString')).toBe('oc1');
  });
});

describe('DEFAULT_REGION', () => {
  // Requirement 1.6: the region used when the visitor has not selected one.
  it('is americas', () => {
    expect(DEFAULT_REGION).toBe('americas');
  });

  it('is itself a supported region, so defaulting can never produce invalid input', () => {
    expect(isValidRegion(DEFAULT_REGION)).toBe(true);
    expect(SUPPORTED_REGIONS).toContain(DEFAULT_REGION);
  });
});
