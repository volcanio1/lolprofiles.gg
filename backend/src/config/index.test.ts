import { describe, it, expect } from 'vitest';
import { loadConfig } from './index';

describe('loadConfig', () => {
  it('loads successfully when RIOT_API_KEY is set', () => {
    const testKeyValue = 'test-only-fake-key-abc123';
    const cfg = loadConfig({ RIOT_API_KEY: testKeyValue, PORT: '4000', DDRAGON_VERSION: '16.17.1' });

    expect(cfg.riotApiKey).toBe(testKeyValue);
    expect(cfg.port).toBe(4000);
  });

  it('defaults the port to 3001 when PORT is not set', () => {
    const cfg = loadConfig({ RIOT_API_KEY: 'some-key', DDRAGON_VERSION: '16.17.1' });
    expect(cfg.port).toBe(3001);
  });

  it('throws a descriptive error when RIOT_API_KEY is absent', () => {
    expect(() => loadConfig({})).toThrow(/RIOT_API_KEY/);
  });

  it('does not leak the configured key value in the thrown error when the key is missing', () => {
    const testKeyValue = 'test-only-fake-key-abc123';
    // Sanity check: the positive-case key value must never appear in an
    // error thrown by a call that never received that value.
    try {
      loadConfig({});
      expect.unreachable('loadConfig should have thrown');
    } catch (err) {
      const error = err as Error;
      expect(error.message).not.toContain(testKeyValue);
      expect(String(error)).not.toContain(testKeyValue);
    }
  });

  it('exposes the pinned Data Dragon version', () => {
    const cfg = loadConfig({ RIOT_API_KEY: 'some-key', DDRAGON_VERSION: '16.17.1' });
    expect(cfg.dataDragonVersion).toBe('16.17.1');
  });

  it('trims surrounding whitespace from DDRAGON_VERSION', () => {
    const cfg = loadConfig({ RIOT_API_KEY: 'some-key', DDRAGON_VERSION: '  16.17.1  ' });
    expect(cfg.dataDragonVersion).toBe('16.17.1');
  });

  it('throws a descriptive error when DDRAGON_VERSION is absent', () => {
    expect(() => loadConfig({ RIOT_API_KEY: 'some-key' })).toThrow(/DDRAGON_VERSION/);
  });

  it('throws when DDRAGON_VERSION is blank rather than accepting an empty pin', () => {
    expect(() => loadConfig({ RIOT_API_KEY: 'some-key', DDRAGON_VERSION: '   ' })).toThrow(
      /DDRAGON_VERSION/,
    );
  });

  it('rejects the moving alias "latest" in any casing', () => {
    for (const alias of ['latest', 'LATEST', 'Latest']) {
      expect(() =>
        loadConfig({ RIOT_API_KEY: 'some-key', DDRAGON_VERSION: alias }),
      ).toThrow(/latest/i);
    }
  });
});
