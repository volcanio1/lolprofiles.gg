/**
 * live-game Requirement 4: the Game_Clock.
 *
 * PURE MODULE. No React, no I/O, no ambient clock — `now` is always passed in.
 *
 * The backend returns `gameStartTime` (epoch ms) and the frontend ticks locally
 * from it (design.md: "The Game_Clock is computed on the client"). Requirement
 * 5.1's 30-second poll floor exists to detect the game *ending*, not to advance a
 * clock, so the two are deliberately decoupled.
 *
 *  - 4.1: elapsed time is derived from the start timestamp and the current time,
 *    never from a stored countdown.
 *  - 4.2: an absent or zero start timestamp is Pre_Game — no clock is shown.
 *  - 4.4: the elapsed value is never negative, in one clamp in one place.
 */

/**
 * Requirement 4.2. Spectator-V5 has returned the game but it has not started:
 * the start timestamp is absent, zero, or otherwise not a usable positive epoch.
 */
export function isPreGame(gameStartTime: number | null | undefined): boolean {
  return (
    gameStartTime === null ||
    gameStartTime === undefined ||
    !Number.isFinite(gameStartTime) ||
    gameStartTime <= 0
  );
}

/**
 * Requirements 4.1 / 4.4: `max(0, now - gameStartTime)`. A Pre_Game timestamp, or
 * a non-finite `now`, yields 0 rather than a negative or `NaN` value — callers
 * should still gate on `isPreGame` to decide whether to render a clock at all.
 */
export function elapsedMs(gameStartTime: number | null | undefined, now: number): number {
  if (isPreGame(gameStartTime) || !Number.isFinite(now)) {
    return 0;
  }
  return Math.max(0, now - (gameStartTime as number));
}

/** `elapsedMs` formatted as `M:SS` (or `H:MM:SS` past an hour). Never negative. */
export function formatGameClock(elapsed: number): string {
  const totalSeconds = Math.floor(Math.max(0, Number.isFinite(elapsed) ? elapsed : 0) / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
