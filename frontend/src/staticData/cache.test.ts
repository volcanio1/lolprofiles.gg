import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STATIC_DATA_TTL_MS,
  clearStoredIndex,
  readStoredIndex,
  writeStoredIndex,
} from './cache';
import type { StaticDataIndex } from './provider';

/** Task 2.1 — Requirement 4.4 (retain for no less than 24 hours). */

const index: StaticDataIndex = {
  version: '16.17.1',
  champions: { MonkeyKing: { name: 'Wukong', image: 'MonkeyKing.png' } },
  items: { '3031': { name: 'Infinity Edge', image: '3031.png', completed: true } },
  spells: {},
  runes: {},
  runeTrees: {},
  augments: {},
};

afterEach(() => {
  clearStoredIndex();
  vi.unstubAllGlobals();
});

describe('static data persistence', () => {
  it('round-trips an index within the TTL', () => {
    writeStoredIndex(index, 1_000);
    expect(readStoredIndex('16.17.1', 1_000)).toEqual(index);
  });

  it('retains for the full 24 hours', () => {
    writeStoredIndex(index, 0);
    expect(readStoredIndex('16.17.1', STATIC_DATA_TTL_MS - 1)).toEqual(index);
  });

  it('still retains at exactly 24 hours, since the requirement is "no less than"', () => {
    writeStoredIndex(index, 0);
    expect(readStoredIndex('16.17.1', STATIC_DATA_TTL_MS)).toEqual(index);
  });

  it('expires past the TTL', () => {
    writeStoredIndex(index, 0);
    expect(readStoredIndex('16.17.1', STATIC_DATA_TTL_MS + 1)).toBeNull();
  });

  it('rejects an entry whose index is an object but has no maps', () => {
    window.localStorage.setItem(
      'lolprofiles.staticData.v3',
      JSON.stringify({ version: '16.17.1', storedAt: 1_000, index: { version: '16.17.1' } }),
    );
    expect(readStoredIndex('16.17.1', 1_000)).toBeNull();
  });

  it('evicts a shapeless entry so the CDN is re-fetched rather than skipped for 24h', () => {
    window.localStorage.setItem(
      'lolprofiles.staticData.v3',
      JSON.stringify({ version: '16.17.1', storedAt: 1_000, index: { version: '16.17.1' } }),
    );
    readStoredIndex('16.17.1', 1_000);
    expect(window.localStorage.getItem('lolprofiles.staticData.v3')).toBeNull();
  });

  it('rejects an entry whose inner version disagrees with the outer one', () => {
    window.localStorage.setItem(
      'lolprofiles.staticData.v3',
      JSON.stringify({
        version: '16.17.1',
        storedAt: 1_000,
        index: { version: '15.24.1', champions: {}, items: {} },
      }),
    );
    expect(readStoredIndex('16.17.1', 1_000)).toBeNull();
  });

  it('refuses an index stored for a different version', () => {
    writeStoredIndex(index, 1_000);
    expect(readStoredIndex('15.24.1', 1_000)).toBeNull();
  });

  it('evicts a version-mismatched entry rather than re-reading it every load', () => {
    writeStoredIndex(index, 1_000);
    readStoredIndex('15.24.1', 1_000);
    expect(readStoredIndex('16.17.1', 1_000)).toBeNull();
  });

  it('returns null when nothing is stored', () => {
    expect(readStoredIndex('16.17.1', 1_000)).toBeNull();
  });

  it('discards a corrupt entry without throwing', () => {
    window.localStorage.setItem('lolprofiles.staticData.v3', '{not json');
    expect(() => readStoredIndex('16.17.1', 1_000)).not.toThrow();
    expect(readStoredIndex('16.17.1', 1_000)).toBeNull();
  });

  it('discards a structurally invalid entry', () => {
    window.localStorage.setItem(
      'lolprofiles.staticData.v3',
      JSON.stringify({ version: '16.17.1', storedAt: 'soon', index }),
    );
    expect(readStoredIndex('16.17.1', 1_000)).toBeNull();
  });

  it('survives a localStorage that throws on read, as in private browsing', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(() => readStoredIndex('16.17.1', 1_000)).not.toThrow();
    expect(readStoredIndex('16.17.1', 1_000)).toBeNull();
  });

  it('survives a quota exception on write', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    });
    expect(() => writeStoredIndex(index, 1_000)).not.toThrow();
  });
});
