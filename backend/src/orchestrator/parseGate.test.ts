import { describe, expect, it } from 'vitest';

import { createParseGate } from './parseGate';

/** A promise plus its resolve/reject handles, for driving tasks by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('createParseGate', () => {
  it('runs tasks immediately up to the concurrency limit and queues the rest', async () => {
    const gate = createParseGate(2);
    const started: number[] = [];
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];

    const runs = gates.map((d, index) =>
      gate.run(async () => {
        started.push(index);
        return d.promise;
      }),
    );

    await flush();
    expect(started).toEqual([0, 1]);

    gates[0].resolve('a');
    await flush();
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve('b');
    gates[2].resolve('c');
    await expect(Promise.all(runs)).resolves.toEqual(['a', 'b', 'c']);
  });

  it('never lets more than `maxConcurrent` tasks run at once', async () => {
    const gate = createParseGate(3);
    let active = 0;
    let peak = 0;
    const gates: ReturnType<typeof deferred<void>>[] = [];

    const runs = Array.from({ length: 12 }, () => {
      const d = deferred<void>();
      gates.push(d);
      return gate.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await d.promise;
        active -= 1;
      });
    });

    // Release in waves; the peak must never exceed the limit.
    for (const d of gates) {
      await flush();
      d.resolve();
    }
    await Promise.all(runs);
    expect(peak).toBe(3);
  });

  it('releases the permit when a task rejects, so queued tasks still run', async () => {
    const gate = createParseGate(1);

    const failing = gate.run(() => Promise.reject(new Error('boom')));
    await expect(failing).rejects.toThrow('boom');

    await expect(gate.run(() => Promise.resolve('after'))).resolves.toBe('after');
  });

  it('hands out queued permits in FIFO order', async () => {
    const gate = createParseGate(1);
    const order: number[] = [];
    const first = deferred<void>();

    const runs = [
      gate.run(async () => {
        order.push(0);
        await first.promise;
      }),
      gate.run(async () => {
        order.push(1);
      }),
      gate.run(async () => {
        order.push(2);
      }),
    ];

    await flush();
    expect(order).toEqual([0]);

    first.resolve();
    await Promise.all(runs);
    expect(order).toEqual([0, 1, 2]);
  });

  it('coerces a non-positive or fractional limit to a sane integer >= 1', async () => {
    const gate = createParseGate(0);
    let active = 0;
    let peak = 0;
    const gates = [deferred<void>(), deferred<void>()];

    const runs = gates.map((d) =>
      gate.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await d.promise;
        active -= 1;
      }),
    );

    await flush();
    expect(peak).toBe(1);
    gates[0].resolve();
    gates[1].resolve();
    await Promise.all(runs);
  });
});
