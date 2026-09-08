import { describe, it, expect } from 'vitest';
import { createCrawlGate } from './crawlGate';

/** A manual clock + a `sleep` that advances it, so no real time passes. */
function manualClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('createCrawlGate', () => {
  it('grants the first `capacity` acquires immediately', async () => {
    const clock = manualClock();
    // rps 4, fraction 0.5 -> 2/s -> capacity 2
    const gate = createCrawlGate({ rps: 4, fraction: 0.5, now: clock.now, sleep: clock.sleep });

    await gate.acquire();
    await gate.acquire();
    expect(clock.now()).toBe(0); // no waiting yet
  });

  it('makes the next acquire wait about one refill interval', async () => {
    const clock = manualClock();
    const gate = createCrawlGate({ rps: 4, fraction: 0.5, now: clock.now, sleep: clock.sleep }); // 2/s

    await gate.acquire();
    await gate.acquire();
    await gate.acquire(); // bucket empty -> must wait

    expect(clock.now()).toBeGreaterThanOrEqual(500); // ~1/(2 per s)
    expect(clock.now()).toBeLessThan(1500);
  });

  it('grants roughly rps*fraction acquires per second over a long run', async () => {
    const clock = manualClock();
    const gate = createCrawlGate({ rps: 10, fraction: 0.2, now: clock.now, sleep: clock.sleep }); // 2/s

    const start = clock.now();
    for (let i = 0; i < 20; i += 1) {
      await gate.acquire();
    }
    const elapsedSeconds = (clock.now() - start) / 1000;
    // 20 acquires at 2/s, minus the initial full bucket (~capacity 2) -> ~9s
    expect(elapsedSeconds).toBeGreaterThan(7);
    expect(elapsedSeconds).toBeLessThan(11);
  });

  it('still trickles when rps*fraction rounds below 1 (never deadlocks)', async () => {
    const clock = manualClock();
    const gate = createCrawlGate({ rps: 1, fraction: 0.01, now: clock.now, sleep: clock.sleep });

    await gate.acquire(); // the one starting token
    await gate.acquire(); // must eventually be granted, just slowly
    expect(clock.now()).toBeGreaterThan(1000);
  });
});
