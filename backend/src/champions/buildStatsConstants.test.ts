import { describe, it, expect } from 'vitest';
import {
  BACKEND_DISPLAY_FLOOR,
  CORE_ITEM_COUNT,
  DEFAULT_RANK,
  DEFAULT_REGION,
  DEFAULT_ROLE,
  MIN_SAMPLE,
  MODAL_MIN_SHARE,
  RANK_BUCKET_VALUES,
  ROLE_VALUES,
  clampRank,
  clampRegion,
  clampRole,
} from './buildStatsConstants';

describe('build-stats constants', () => {
  it('pins the spec-fixed values', () => {
    // Glossary "Min_Sample" / Requirement 11.4
    expect(MIN_SAMPLE).toBe(500);
    // Glossary "Core_Item_Count" / Requirement 11.2
    expect(CORE_ITEM_COUNT).toBe(3);
  });

  it('keeps the interpretation-choice thresholds in a sane range', () => {
    expect(BACKEND_DISPLAY_FLOOR).toBeGreaterThan(0);
    expect(MODAL_MIN_SHARE).toBeGreaterThan(0);
    expect(MODAL_MIN_SHARE).toBeLessThanOrEqual(1);
  });

  it('exposes the role vocabulary with ALL first', () => {
    expect(ROLE_VALUES).toEqual(['ALL', 'TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']);
    expect(ROLE_VALUES[0]).toBe(DEFAULT_ROLE);
  });

  it('exposes the v1 rank buckets with ALL first', () => {
    expect(RANK_BUCKET_VALUES).toEqual(['ALL', 'EMERALD_PLUS', 'DIAMOND_PLUS', 'MASTER_PLUS']);
    expect(RANK_BUCKET_VALUES[0]).toBe(DEFAULT_RANK);
  });
});

describe('clampRole / clampRank / clampRegion (Requirement 10.4)', () => {
  it('passes a known value through unchanged', () => {
    expect(clampRole('JUNGLE')).toBe('JUNGLE');
    expect(clampRank('DIAMOND_PLUS')).toBe('DIAMOND_PLUS');
    expect(clampRegion('world')).toBe('world');
  });

  it('clamps an unknown or absent value to the default rather than throwing', () => {
    expect(clampRole('midlane')).toBe(DEFAULT_ROLE);
    expect(clampRole(undefined)).toBe(DEFAULT_ROLE);
    expect(clampRole('')).toBe(DEFAULT_ROLE);
    expect(clampRank('BRONZE_PLUS')).toBe(DEFAULT_RANK);
    expect(clampRank(undefined)).toBe(DEFAULT_RANK);
  });

  it('clamps a region not in the advertised set to world', () => {
    expect(clampRegion('na', ['world'])).toBe(DEFAULT_REGION);
    expect(clampRegion(undefined, ['world'])).toBe(DEFAULT_REGION);
    // once the store advertises more regions, a member passes through
    expect(clampRegion('na', ['world', 'na'])).toBe('na');
  });

  it('is case-sensitive — Riot filter tokens are upper-case', () => {
    expect(clampRole('jungle')).toBe(DEFAULT_ROLE);
  });
});
