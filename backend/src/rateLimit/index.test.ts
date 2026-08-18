import { describe, it, expect } from 'vitest';
import {
  MAX_QUEUED_WAIT_MS,
  RateLimitExceededError,
  createRateLimitManager,
  parseRateLimitPairs,
  readHeader,
  type RateLimitHeaders,
} from './index';

/**
 * Fake clock plus fake sleep. The sleep ADVANCES the clock by the slept amount
 * and records the duration, which is how these tests observe delays without any
 * real timers.
 */
function createHarness(startAt = 1_000_000) {
  let current = startAt;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      current += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      current += ms;
    },
    get sleeps() {
      return sleeps;
    },
    get totalSlept() {
      return sleeps.reduce((sum, ms) => sum + ms, 0);
    },
  };
}

/** Minimal structural stand-in for fetch `Headers`, with case-insensitive `get`. */
function fakeHeaders(entries: Record<string, string>): RateLimitHeaders {
  const lowered = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => lowered.get(name.toLowerCase()) ?? null };
}

function appHeaders(limit: string, count: string): RateLimitHeaders {
  return fakeHeaders({ 'X-App-Rate-Limit': limit, 'X-App-Rate-Limit-Count': count });
}

function methodHeaders(limit: string, count: string): RateLimitHeaders {
  return fakeHeaders({ 'X-Method-Rate-Limit': limit, 'X-Method-Rate-Limit-Count': count });
}

describe('parseRateLimitPairs', () => {
  it('parses a multi-window pair list', () => {
    expect(parseRateLimitPairs('20:1,100:120')).toEqual([
      { count: 20, seconds: 1 },
      { count: 100, seconds: 120 },
    ]);
  });

  it('parses a single window and tolerates surrounding whitespace', () => {
    expect(parseRateLimitPairs(' 20:1 , 100:120 ')).toEqual([
      { count: 20, seconds: 1 },
      { count: 100, seconds: 120 },
    ]);
  });

  it('returns an empty list for absent or empty headers', () => {
    expect(parseRateLimitPairs(null)).toEqual([]);
    expect(parseRateLimitPairs(undefined)).toEqual([]);
    expect(parseRateLimitPairs('')).toEqual([]);
  });

  it('skips malformed pairs without throwing and keeps the readable ones', () => {
    expect(parseRateLimitPairs('garbage,20:1,:,3:,:4,5:0,-1:2,1.5:2,100:120')).toEqual([
      { count: 20, seconds: 1 },
      { count: 100, seconds: 120 },
    ]);
  });

  it('keeps the last pair when a duration is repeated', () => {
    expect(parseRateLimitPairs('5:1,9:1')).toEqual([{ count: 9, seconds: 1 }]);
  });
});

describe('readHeader', () => {
  it('reads from a Headers-like object case-insensitively', () => {
    const headers = fakeHeaders({ 'x-app-rate-limit': '20:1' });
    expect(readHeader(headers, 'X-App-Rate-Limit')).toBe('20:1');
  });

  it('reads from a plain record case-insensitively', () => {
    expect(readHeader({ 'X-APP-RATE-LIMIT': '20:1' }, 'x-app-rate-limit')).toBe('20:1');
  });

  it('takes the first value of an array-valued record header', () => {
    expect(readHeader({ 'x-app-rate-limit': ['20:1', '99:9'] }, 'X-App-Rate-Limit')).toBe('20:1');
  });

  it('returns null for an absent header', () => {
    expect(readHeader({}, 'X-App-Rate-Limit')).toBeNull();
    expect(readHeader(fakeHeaders({}), 'X-App-Rate-Limit')).toBeNull();
  });
});

describe('recordResponseHeaders', () => {
  it('does not throw on absent or malformed headers and tracks no limits', async () => {
    const harness = createHarness();
    const manager = createRateLimitManager(harness);

    manager.recordResponseHeaders('americas', 'account', fakeHeaders({}));
    manager.recordResponseHeaders(
      'americas',
      'account',
      fakeHeaders({ 'X-App-Rate-Limit': 'nonsense', 'X-App-Rate-Limit-Count': ':::' }),
    );
    manager.recordResponseHeaders('americas', 'account', {});

    expect(manager.snapshotForVerification()).toEqual([]);

    for (let index = 0; index < 50; index += 1) {
      await manager.reserveSlot('americas', 'account');
    }
    expect(harness.totalSlept).toBe(0);
  });

  it('tracks every declared window from a multi-window header', () => {
    const harness = createHarness();
    const manager = createRateLimitManager(harness);

    manager.recordResponseHeaders('americas', 'account', appHeaders('20:1,100:120', '1:1,1:120'));

    expect(manager.snapshotForVerification()).toEqual([
      { scopeKey: 'app|americas', durationSeconds: 1, limit: 20, count: 1 },
      { scopeKey: 'app|americas', durationSeconds: 120, limit: 100, count: 1 },
    ]);
  });

  it('raises local usage to Riot\u2019s reported count when Riot reports more', () => {
    const harness = createHarness();
    const manager = createRateLimitManager(harness);

    manager.recordResponseHeaders('americas', 'account', appHeaders('20:1', '7:1'));

    expect(manager.snapshotForVerification()).toEqual([
      { scopeKey: 'app|americas', durationSeconds: 1, limit: 20, count: 7 },
    ]);
  });

  it('never lowers local usage to a lagging reported count', async () => {
    const harness = createHarness();
    const manager = createRateLimitManager(harness);

    manager.recordResponseHeaders('americas', 'account', appHeaders('20:1', '0:1'));
    for (let index = 0; index < 5; index += 1) {
      await manager.reserveSlot('americas', 'account');
    }

    manager.recordResponseHeaders('americas', 'account', appHeaders('20:1', '1:1'));

    expect(manager.snapshotForVerification()).toEqual([
      { scopeKey: 'app|americas', durationSeconds: 1, limit: 20, count: 5 },
    ]);
  });

  it('preserves recorded usage when a later response re-declares the same window', async () => {
    const harness = createHarness();
    const manager = createRateLimitManager(harness);

    manager.recordResponseHeaders('americas', 'account', appHeaders('20:1', '0:1'));
    await manager.reserveSlot('americas', 'account');
    await manager.reserveSlot('americas', 'account');

    manager.recordResponseHeaders('americas', 'account', appHeaders('20:1', '0:1'));

    expect(manager.snapshotForVerification()).toEqual([
      { scopeKey: 'app|americas', durationSeconds: 1, limit: 20, count: 2 },
    ]);
  });
});

describe('reserveSlot', () => {
  it('returns immediately without sleeping when no limits are known yet', async () => {
    const harness = createHarness();
    const manager = createRateLimitManager(harness);

    await manager.reserveSlot('americas', 'account');

    expect(harness.sleeps).toEqual([]);
  });

  it('returns immediately while the window has capacity', async () => {
    const harness = createHarness();
    const manager = createRateLimitManager(harness);
    manager.recordResponseHeaders('americas', 'account', appHeaders('3:1', '0:1'));

    await manager.reserveSlot('americas', 'account');
    await manager.reserveSlot('americas', 'account');
    await manager.reserveSlot('americas', 'account');

    expect(harness.sleeps).toEqual([]);
  });

  it('delays by exactly the wait until the oldest occupant expires, then proceeds', async () => {
    const harness = createHarness();
    const manager = createRateLimitManager(harness);
    // 2 requests per 10s.
    manager.recordResponseHeaders('americas', 'account', appHeaders('2:10', '0:10'));

    await manager.reserveSlot('americas', 'account'); // occupies until +10_000
    harness.advance(4_000);
    await manager.reserveSlot('americas', 'account'); // window now full

    await manager.reserveSlot('americas', 'account');

    // Oldest expires 10s after it was recorded, i.e. 6s after the current clock.
    expect(harness.sleeps).toEqual([6_000]);
    expect(manager.snapshotForVerification()).toEqual([
      { scopeKey: 'app|americas', durationSeconds: 10, limit: 2, count: 2 },
    ]);
  });

  it('throws RateLimitExceededError without sleeping at all when the wait exceeds 30s', async () => {
    const harness = createHarness();
    const manager = createRateLimitManager(harness);
    // 1 request per 120s: clearing the window needs 120s.
    manager.recordResponseHeaders('americas', 'account', appHeaders('1:120', '0:120'));

    await manager.reserveSlot('americas', 'account');

    await expect(manager.reserveSlot('americas', 'account')).rejects.toBeInstanceOf(RateLimitExceededError);
    expect(harness.sleeps).toEqual([]);

    const error = await manager.reserveSlot('americas', 'account').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitExceededError);
    const rateLimitError = error as RateLimitExceededError;
    expect(rateLimitError.routingValue).toBe('americas');
    expect(rateLimitError.method).toBe('account');
    expect(rateLimitError.requiredWaitMs).toBeGreaterThan(MAX_QUEUED_WAIT_MS);
    expect(rateLimitError.message).not.toContain('key');
  });

  it('waits at the 30s boundary rather than throwing', async () => {
    const harness = createHarness();
    const manager = createRateLimitManager(harness);
    manager.recordResponseHeaders('americas', 'account', appHeaders('1:30', '0:30'));

    await manager.reserveSlot('americas', 'account');
    await manager.reserveSlot('americas', 'account');

    expect(harness.sleeps).toEqual([MAX_QUEUED_WAIT_MS]);
  });

  it('throws when a window declares a limit of zero, since it can never admit a request', async () => {
    const harness = createHarness();
    const manager = createRateLimitManager(harness);
    manager.recordResponseHeaders('americas', 'account', appHeaders('0:1', '0:1'));

    await expect(manager.reserveSlot('americas', 'account')).rejects.toBeInstanceOf(RateLimitExceededError);
    expect(harness.sleeps).toEqual([]);
  });

  it('shares app-level limits across different methods on the same routing value', async () => {
    const harness = createHarness();
    const manager = createRateLimitManager(harness);
    manager.recordResponseHeaders('americas', 'account', appHeaders('2:10', '0:10'));

    await manager.reserveSlot('americas', 'account');
    await manager.reserveSlot('americas', 'matchIds');
    expect(harness.sleeps).toEqual([]);

    await manager.reserveSlot('americas', 'matchDetail');
    expect(harness.sleeps).toEqual([10_000]);
  });

  it('isolates method-level limits per method', async () => {
    const harness = createHarness();
    const manager = createRateLimitManager(harness);
    manager.recordResponseHeaders('americas', 'account', methodHeaders('1:10', '0:10'));
    manager.recordResponseHeaders('americas', 'matchIds', methodHeaders('1:10', '0:10'));

    await manager.reserveSlot('americas', 'account');
    await manager.reserveSlot('americas', 'matchIds');

    expect(harness.sleeps).toEqual([]);

    await manager.reserveSlot('americas', 'account');
    expect(harness.sleeps).toEqual([10_000]);
  });

  it('isolates routing values from each other', async () => {
    const harness = createHarness();
    const manager = createRateLimitManager(harness);
    manager.recordResponseHeaders('americas', 'account', appHeaders('1:10', '0:10'));
    manager.recordResponseHeaders('europe', 'account', appHeaders('1:10', '0:10'));

    await manager.reserveSlot('americas', 'account');
    await manager.reserveSlot('europe', 'account');

    expect(harness.sleeps).toEqual([]);
  });

  it('enforces app-level and method-level windows together', async () => {
    const harness = createHarness();
    const manager = createRateLimitManager(harness);
    manager.recordResponseHeaders(
      'americas',
      'account',
      fakeHeaders({
        'X-App-Rate-Limit': '10:10',
        'X-App-Rate-Limit-Count': '0:10',
        'X-Method-Rate-Limit': '1:5',
        'X-Method-Rate-Limit-Count': '0:5',
      }),
    );

    await manager.reserveSlot('americas', 'account');
    await manager.reserveSlot('americas', 'account');

    // App window still has room; the tighter method window is what delays.
    expect(harness.sleeps).toEqual([5_000]);
  });

  it('frees capacity as the clock advances past the window duration', async () => {
    const harness = createHarness();
    const manager = createRateLimitManager(harness);
    manager.recordResponseHeaders('americas', 'account', appHeaders('1:10', '0:10'));

    await manager.reserveSlot('americas', 'account');
    harness.advance(10_000);
    await manager.reserveSlot('americas', 'account');

    expect(harness.sleeps).toEqual([]);
    expect(manager.snapshotForVerification()).toEqual([
      { scopeKey: 'app|americas', durationSeconds: 10, limit: 1, count: 1 },
    ]);
  });

  it('accounts for reconciled usage when deciding to delay', async () => {
    const harness = createHarness();
    const manager = createRateLimitManager(harness);
    // Riot reports the window already full even though we sent nothing locally.
    manager.recordResponseHeaders('americas', 'account', appHeaders('2:10', '2:10'));

    await manager.reserveSlot('americas', 'account');

    expect(harness.sleeps).toEqual([10_000]);
  });
});
