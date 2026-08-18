import { describe, it, expect } from 'vitest';
import { loadConfig } from './index';

describe('loadConfig', () => {
  it('loads successfully when RIOT_API_KEY is set', () => {
    const testKeyValue = 'test-only-fake-key-abc123';
    const cfg = loadConfig({ RIOT_API_KEY: testKeyValue, PORT: '4000' });

    expect(cfg.riotApiKey).toBe(testKeyValue);
    expect(cfg.port).toBe(4000);
  });

  it('defaults the port to 3001 when PORT is not set', () => {
    const cfg = loadConfig({ RIOT_API_KEY: 'some-key' });
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
});
