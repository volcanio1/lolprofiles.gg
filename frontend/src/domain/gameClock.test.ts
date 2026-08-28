import { describe, expect, it } from 'vitest';
import { elapsedMs, formatGameClock, isPreGame } from './gameClock';

describe('isPreGame', () => {
  it('is true for an absent or zero start timestamp', () => {
    expect(isPreGame(null)).toBe(true);
    expect(isPreGame(undefined)).toBe(true);
    expect(isPreGame(0)).toBe(true);
  });

  it('is true for a non-positive or non-finite timestamp', () => {
    expect(isPreGame(-1)).toBe(true);
    expect(isPreGame(Number.NaN)).toBe(true);
    expect(isPreGame(Number.POSITIVE_INFINITY)).toBe(true);
  });

  it('is false for a real epoch-ms start timestamp', () => {
    expect(isPreGame(1_700_000_000_000)).toBe(false);
  });
});

describe('elapsedMs', () => {
  it('is now - gameStartTime for a started game', () => {
    expect(elapsedMs(1_000, 61_000)).toBe(60_000);
  });

  it('clamps at zero when now precedes the start (Requirement 4.4)', () => {
    expect(elapsedMs(61_000, 1_000)).toBe(0);
  });

  it('is zero for Pre_Game or a non-finite now', () => {
    expect(elapsedMs(0, 61_000)).toBe(0);
    expect(elapsedMs(null, 61_000)).toBe(0);
    expect(elapsedMs(1_000, Number.NaN)).toBe(0);
  });
});

describe('formatGameClock', () => {
  it('formats as M:SS under an hour and H:MM:SS past it', () => {
    expect(formatGameClock(0)).toBe('0:00');
    expect(formatGameClock(65_000)).toBe('1:05');
    expect(formatGameClock(3_661_000)).toBe('1:01:01');
  });

  it('never renders a negative clock', () => {
    expect(formatGameClock(-5_000)).toBe('0:00');
  });
});
