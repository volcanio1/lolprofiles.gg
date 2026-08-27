import { describe, expect, it } from 'vitest';
import { PLATFORM_LABELS, REGION_TO_PLATFORMS, SUPPORTED_REGIONS, platformLabel } from './regions';
import {
  MAX_GAME_NAME_LENGTH,
  MAX_TAG_LINE_LENGTH,
  RIOT_ID_ERROR_DISPLAY,
  messageForRiotIdError,
  validateRiotId,
  type RiotIdErrorCode,
} from './riotId';

/**
 * Pure domain rules. These mirror backend modules, so the assertions are written
 * against the literal numbers and values in the requirements rather than against
 * the backend's constants — that is what would catch a drift between the two copies.
 */

describe('validateRiotId — Requirements 1.2-1.5', () => {
  it('accepts a well-formed Riot ID and returns the trimmed parts', () => {
    expect(validateRiotId('Doffy#Smile')).toEqual({ ok: true, riotId: { gameName: 'Doffy', tagLine: 'Smile' } });
    expect(validateRiotId('  Doffy  #  EUW  ')).toEqual({
      ok: true,
      riotId: { gameName: 'Doffy', tagLine: 'EUW' },
    });
  });

  it('rejects a value without exactly one # (Requirement 1.3)', () => {
    expect(validateRiotId('Doffy')).toEqual({ ok: false, errorCode: 'MISSING_HASH' });
    expect(validateRiotId('')).toEqual({ ok: false, errorCode: 'MISSING_HASH' });
    expect(validateRiotId('Doffy#Smile#Extra')).toEqual({ ok: false, errorCode: 'MULTIPLE_HASH' });
  });

  it('rejects an empty or whitespace-only part (Requirement 1.4)', () => {
    expect(validateRiotId('#Smile')).toEqual({ ok: false, errorCode: 'EMPTY_PART' });
    expect(validateRiotId('Doffy#')).toEqual({ ok: false, errorCode: 'EMPTY_PART' });
    expect(validateRiotId('   #   ')).toEqual({ ok: false, errorCode: 'EMPTY_PART' });
  });

  it('enforces the length limits from Requirement 1.5, measured after trimming', () => {
    // The requirement's literal numbers, not the module's constants.
    expect(MAX_GAME_NAME_LENGTH).toBe(16);
    expect(MAX_TAG_LINE_LENGTH).toBe(5);

    expect(validateRiotId(`${'a'.repeat(16)}#EUW`).ok).toBe(true);
    expect(validateRiotId(`${'a'.repeat(17)}#EUW`)).toEqual({ ok: false, errorCode: 'GAME_NAME_TOO_LONG' });
    expect(validateRiotId('Doffy#12345').ok).toBe(true);
    expect(validateRiotId('Doffy#123456')).toEqual({ ok: false, errorCode: 'TAG_LINE_TOO_LONG' });
    // Trimming happens before measuring, so padding does not push it over.
    expect(validateRiotId(`   ${'a'.repeat(16)}   #EUW`).ok).toBe(true);
  });

  it('reports the game name violation first when both lengths are exceeded', () => {
    expect(validateRiotId(`${'a'.repeat(17)}#123456`)).toEqual({
      ok: false,
      errorCode: 'GAME_NAME_TOO_LONG',
    });
  });

  it('provides a distinct message naming the rule for every error code (Requirement 9.1)', () => {
    const codes: RiotIdErrorCode[] = [
      'MISSING_HASH',
      'MULTIPLE_HASH',
      'EMPTY_PART',
      'GAME_NAME_TOO_LONG',
      'TAG_LINE_TOO_LONG',
    ];
    const messages = new Set(codes.map((code) => RIOT_ID_ERROR_DISPLAY[code].message));
    expect(messages.size).toBe(codes.length);

    for (const code of ['MISSING_HASH', 'MULTIPLE_HASH', 'EMPTY_PART'] as const) {
      expect(RIOT_ID_ERROR_DISPLAY[code].message, code).toContain('gameName#tagLine');
      expect(RIOT_ID_ERROR_DISPLAY[code].field, code).toBe('riotId');
    }
    expect(RIOT_ID_ERROR_DISPLAY.GAME_NAME_TOO_LONG.message).toContain('16');
    expect(RIOT_ID_ERROR_DISPLAY.GAME_NAME_TOO_LONG.field).toBe('gameName');
    expect(RIOT_ID_ERROR_DISPLAY.TAG_LINE_TOO_LONG.message).toContain('5');
    expect(RIOT_ID_ERROR_DISPLAY.TAG_LINE_TOO_LONG.field).toBe('tagLine');
  });

  it('falls back to the format message for a code the backend added later', () => {
    expect(messageForRiotIdError('SOMETHING_NEW')).toBe(RIOT_ID_ERROR_DISPLAY.MISSING_HASH.message);
    expect(messageForRiotIdError(undefined)).toBe(RIOT_ID_ERROR_DISPLAY.MISSING_HASH.message);
    expect(messageForRiotIdError('TAG_LINE_TOO_LONG')).toBe(RIOT_ID_ERROR_DISPLAY.TAG_LINE_TOO_LONG.message);
  });
});

describe('regions — parity table and platform display (lookup-pipeline-fixes)', () => {
  it('offers exactly the four regions the backend supports, in mapping order', () => {
    expect(SUPPORTED_REGIONS).toEqual(['americas', 'europe', 'asia', 'sea']);
  });

  it('maps each region to exactly its documented platforms, in order', () => {
    // Transcribed from the requirement, not imported from the backend.
    expect(REGION_TO_PLATFORMS.americas).toEqual(['na1', 'br1', 'la1', 'la2']);
    expect(REGION_TO_PLATFORMS.europe).toEqual(['euw1', 'eun1', 'tr1', 'ru']);
    expect(REGION_TO_PLATFORMS.asia).toEqual(['kr', 'jp1']);
    expect(REGION_TO_PLATFORMS.sea).toEqual(['oc1']);
  });

  it('keeps regions disjoint and covers exactly eleven platforms', () => {
    const all = Object.values(REGION_TO_PLATFORMS).flat();
    expect(all).toHaveLength(11);
    expect(new Set(all).size).toBe(11);
  });

  it('labels every platform, so no raw routing value reaches the report (Requirement 2.3)', () => {
    for (const platform of Object.values(REGION_TO_PLATFORMS).flat()) {
      expect(PLATFORM_LABELS[platform]?.length, platform).toBeGreaterThan(0);
    }
  });

  it('platformLabel returns the friendly name for a known platform', () => {
    expect(platformLabel('euw1')).toBe(PLATFORM_LABELS.euw1);
    expect(platformLabel('na1')).toBe(PLATFORM_LABELS.na1);
  });

  it('platformLabel degrades to the uppercased raw value for an unknown platform, never empty', () => {
    expect(platformLabel('vn2')).toBe('VN2');
  });
});
