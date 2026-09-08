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

  it('leaves matchHistoryCount undefined when MATCH_HISTORY_COUNT is unset', () => {
    const cfg = loadConfig({ RIOT_API_KEY: 'some-key', DDRAGON_VERSION: '16.17.1' });
    expect(cfg.matchHistoryCount).toBeUndefined();
  });

  it('reads MATCH_HISTORY_COUNT as a positive integer', () => {
    const cfg = loadConfig({ RIOT_API_KEY: 'some-key', DDRAGON_VERSION: '16.17.1', MATCH_HISTORY_COUNT: '30' });
    expect(cfg.matchHistoryCount).toBe(30);
  });

  it('rejects a non-positive or non-numeric MATCH_HISTORY_COUNT', () => {
    for (const bad of ['0', '-5', 'lots']) {
      expect(() =>
        loadConfig({ RIOT_API_KEY: 'some-key', DDRAGON_VERSION: '16.17.1', MATCH_HISTORY_COUNT: bad }),
      ).toThrow(/MATCH_HISTORY_COUNT/);
    }
  });

  it('leaves mongodbUri undefined when MONGODB_URI is unset or blank', () => {
    expect(loadConfig({ RIOT_API_KEY: 'k', DDRAGON_VERSION: '16.17.1' }).mongodbUri).toBeUndefined();
    expect(
      loadConfig({ RIOT_API_KEY: 'k', DDRAGON_VERSION: '16.17.1', MONGODB_URI: '   ' }).mongodbUri,
    ).toBeUndefined();
  });

  it('surfaces MONGODB_URI trimmed when set (shape is validated by the driver, not here)', () => {
    const cfg = loadConfig({
      RIOT_API_KEY: 'k',
      DDRAGON_VERSION: '16.17.1',
      MONGODB_URI: '  mongodb+srv://u:p@host/db  ',
    });
    expect(cfg.mongodbUri).toBe('mongodb+srv://u:p@host/db');
  });

  describe('crawler config (champion-build-stats-pipeline)', () => {
    const base = { RIOT_API_KEY: 'k', DDRAGON_VERSION: '16.17.1' } as const;

    it('is off with safe defaults when nothing is set', () => {
      expect(loadConfig(base).crawler).toEqual({
        enabled: false,
        budgetFraction: 0.25,
        rps: 0.8,
        intervalMs: 300_000,
        seedsPerCycle: 25,
        matchesPerSeed: 20,
      });
    });

    it('parses CRAWLER_ENABLED truthiness', () => {
      expect(loadConfig({ ...base, CRAWLER_ENABLED: '1' }).crawler.enabled).toBe(true);
      expect(loadConfig({ ...base, CRAWLER_ENABLED: 'TRUE' }).crawler.enabled).toBe(true);
      expect(loadConfig({ ...base, CRAWLER_ENABLED: 'yes' }).crawler.enabled).toBe(true);
      expect(loadConfig({ ...base, CRAWLER_ENABLED: '0' }).crawler.enabled).toBe(false);
      expect(loadConfig({ ...base, CRAWLER_ENABLED: 'nope' }).crawler.enabled).toBe(false);
    });

    it('clamps CRAWL_BUDGET_FRACTION to (0, 1]', () => {
      expect(loadConfig({ ...base, CRAWL_BUDGET_FRACTION: '0.5' }).crawler.budgetFraction).toBe(0.5);
      expect(loadConfig({ ...base, CRAWL_BUDGET_FRACTION: '3' }).crawler.budgetFraction).toBe(1);
    });

    it('reads the numeric knobs and throws on garbage', () => {
      const cfg = loadConfig({
        ...base,
        CRAWL_RPS: '2.5',
        CRAWL_INTERVAL_MS: '60000',
        CRAWL_SEEDS_PER_CYCLE: '5',
        CRAWL_MATCHES_PER_SEED: '3',
      });
      expect(cfg.crawler).toMatchObject({ rps: 2.5, intervalMs: 60_000, seedsPerCycle: 5, matchesPerSeed: 3 });
      expect(() => loadConfig({ ...base, CRAWL_SEEDS_PER_CYCLE: 'lots' })).toThrow(/CRAWL_SEEDS_PER_CYCLE/);
      expect(() => loadConfig({ ...base, CRAWL_RPS: '-1' })).toThrow(/CRAWL_RPS/);
    });
  });
});
