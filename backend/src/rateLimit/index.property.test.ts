import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { RateLimitExceededError, createRateLimitManager, type RateLimitHeaders } from './index';

// Feature: lolprofiles-gg, Property 7: Rate limit reservation never permits exceeding the tracked window, and never blocks longer than 30 seconds
// **Validates: Requirements 4.3, 4.4, 4.5**

/**
 * Transcribed independently from Requirements 4.4/4.5 rather than imported from
 * the module, so the property compares the implementation against the
 * specification instead of against itself.
 */
const SPEC_MAX_WAIT_MS = 30_000;

const ROUTING_VALUES = ['americas', 'europe'] as const;
const METHODS = ['account', 'matchIds'] as const;

interface WindowSpec {
  limit: number;
  seconds: number;
}

interface ScopeConfig {
  app: WindowSpec[];
  method: WindowSpec[];
}

/**
 * Small limits and a mix of durations either side of the 30s boundary, so runs
 * reach the immediate, delayed and throwing paths (asserted below).
 */
const windowSpecsArb = fc.uniqueArray(
  fc.record({ limit: fc.integer({ min: 1, max: 3 }), seconds: fc.constantFrom(1, 5, 30, 60, 120) }),
  { selector: (spec: WindowSpec) => spec.seconds, minLength: 1, maxLength: 2 },
);

const configArb: fc.Arbitrary<ScopeConfig> = fc.record({ app: windowSpecsArb, method: windowSpecsArb });

const callArb = fc.record({
  routingValue: fc.constantFrom(...ROUTING_VALUES),
  method: fc.constantFrom(...METHODS),
  /** Clock advancement applied before the call. */
  advanceMs: fc.constantFrom(0, 0, 1, 500, 1_000, 5_000, 30_000, 120_000),
});

const callsArb = fc.array(callArb, { minLength: 1, maxLength: 12 });

function limitHeaderValue(specs: readonly WindowSpec[]): string {
  return specs.map((spec) => `${String(spec.limit)}:${String(spec.seconds)}`).join(',');
}

function zeroCountHeaderValue(specs: readonly WindowSpec[]): string {
  return specs.map((spec) => `0:${String(spec.seconds)}`).join(',');
}

/**
 * Seeds the manager with the generated window configuration and a reported usage
 * of zero, so local accounting alone drives the run and the oracle below can
 * mirror it exactly.
 */
function seedHeaders(config: ScopeConfig): RateLimitHeaders {
  return {
    'x-app-rate-limit': limitHeaderValue(config.app),
    'x-app-rate-limit-count': zeroCountHeaderValue(config.app),
    'x-method-rate-limit': limitHeaderValue(config.method),
    'x-method-rate-limit-count': zeroCountHeaderValue(config.method),
  };
}

/**
 * Independent oracle: sliding-window bookkeeping written from the requirement
 * text, tracking the timestamps of requests the manager actually released.
 */
class ReleaseOracle {
  private readonly released = new Map<string, number[]>();

  constructor(private readonly config: ScopeConfig) {}

  private scopesFor(routingValue: string, method: string): { key: string; specs: readonly WindowSpec[] }[] {
    return [
      { key: `app|${routingValue}`, specs: this.config.app },
      { key: `method|${routingValue}|${method}`, specs: this.config.method },
    ];
  }

  private inWindow(key: string, seconds: number, now: number): number[] {
    const cutoff = now - seconds * 1000;
    return (this.released.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
  }

  /** Wait required before one more request may be released, per the requirement. */
  requiredWaitMs(routingValue: string, method: string, now: number): number {
    let wait = 0;
    for (const scope of this.scopesFor(routingValue, method)) {
      for (const spec of scope.specs) {
        const occupants = this.inWindow(scope.key, spec.seconds, now).sort((a, b) => a - b);
        if (occupants.length < spec.limit) {
          continue;
        }
        const expiringAt = occupants[occupants.length - spec.limit] + spec.seconds * 1000;
        wait = Math.max(wait, expiringAt - now);
      }
    }
    return wait;
  }

  recordRelease(routingValue: string, method: string, at: number): void {
    for (const scope of this.scopesFor(routingValue, method)) {
      const timestamps = this.released.get(scope.key) ?? [];
      timestamps.push(at);
      this.released.set(scope.key, timestamps);
    }
  }

  /** Clause (a): no tracked window may hold more releases than its declared limit. */
  assertNoWindowExceeded(routingValue: string, method: string, at: number): void {
    for (const scope of this.scopesFor(routingValue, method)) {
      for (const spec of scope.specs) {
        expect(this.inWindow(scope.key, spec.seconds, at).length).toBeLessThanOrEqual(spec.limit);
      }
    }
  }
}

describe('Property 7: rate limit reservation respects tracked windows and the 30s wait budget', () => {
  it('never exceeds a tracked window and never blocks longer than 30 seconds', async () => {
    let immediateCount = 0;
    let delayedCount = 0;
    let threwCount = 0;

    await fc.assert(
      fc.asyncProperty(configArb, callsArb, async (config, calls) => {
        // Fake clock; the fake sleep advances it by the slept amount and records
        // the duration. No real timers, so the whole property runs fast.
        let clock = 1_000_000;
        let sleptInCall = 0;
        let sleepCallsInCall = 0;
        const manager = createRateLimitManager({
          now: () => clock,
          sleep: (ms: number) => {
            sleptInCall += ms;
            sleepCallsInCall += 1;
            clock += ms;
            return Promise.resolve();
          },
        });

        for (const routingValue of ROUTING_VALUES) {
          for (const method of METHODS) {
            manager.recordResponseHeaders(routingValue, method, seedHeaders(config));
          }
        }

        const oracle = new ReleaseOracle(config);

        for (const call of calls) {
          clock += call.advanceMs;
          const startedAt = clock;
          const expectedWaitMs = oracle.requiredWaitMs(call.routingValue, call.method, startedAt);

          sleptInCall = 0;
          sleepCallsInCall = 0;

          let thrown: unknown;
          try {
            await manager.reserveSlot(call.routingValue, call.method);
          } catch (caught: unknown) {
            thrown = caught;
          }

          if (thrown !== undefined) {
            // (b) a rejecting call must not have slept at all.
            expect(thrown).toBeInstanceOf(RateLimitExceededError);
            expect(sleptInCall).toBe(0);
            expect(clock).toBe(startedAt);
            // (c) it only throws when waiting genuinely could not have helped.
            expect(expectedWaitMs).toBeGreaterThan(SPEC_MAX_WAIT_MS);
            threwCount += 1;
            continue;
          }

          // (b) a resolving call sleeps at most the 30s budget in total, and
          // sleeps exactly the wait the requirement prescribes.
          expect(sleptInCall).toBeLessThanOrEqual(SPEC_MAX_WAIT_MS);
          expect(sleptInCall).toBe(expectedWaitMs);
          expect(sleepCallsInCall).toBeLessThanOrEqual(1);

          // (a) the released request must not push any window past its limit.
          oracle.recordRelease(call.routingValue, call.method, clock);
          oracle.assertNoWindowExceeded(call.routingValue, call.method, clock);

          if (sleptInCall === 0) {
            immediateCount += 1;
          } else {
            delayedCount += 1;
          }
        }
      }),
      { numRuns: 100 },
    );

    // Non-degenerate coverage: all three paths were exercised.
    expect(immediateCount).toBeGreaterThan(0);
    expect(delayedCount).toBeGreaterThan(0);
    expect(threwCount).toBeGreaterThan(0);
  });
});
