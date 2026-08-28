import { describe, expect, it } from 'vitest';
import { REFRESH_COOLDOWN_MS, SNAPSHOT_MAX_AGE_MS } from './cachedReport';

/**
 * Asserted against the literal values in specs/autofill-search/ design.md, not
 * against the backend constants — the backend pins the same literals in its own
 * `api/cachedReport.test.ts`, so a drift in either copy fails a test.
 */
describe('cached-report timing constants', () => {
  it('SNAPSHOT_MAX_AGE_MS is 15 days', () => {
    expect(SNAPSHOT_MAX_AGE_MS).toBe(15 * 24 * 60 * 60 * 1000);
  });

  it('REFRESH_COOLDOWN_MS is 5 minutes', () => {
    expect(REFRESH_COOLDOWN_MS).toBe(5 * 60 * 1000);
  });
});
