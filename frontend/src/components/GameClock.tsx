/**
 * The local Game_Clock (live-game Requirement 4).
 *
 *  - 4.1: elapsed time is derived from `gameStartTime` and the current time.
 *  - 4.2: an absent/zero start timestamp renders as Pre-Game — no clock.
 *  - 4.3: it ticks on a local `setInterval`; no request is ever issued to advance
 *    it (the poll in `useLiveGame` is a separate concern).
 *  - 4.4: `formatGameClock` clamps at zero, so a value is never negative.
 */

import { useEffect, useState } from 'react';
import { elapsedMs, formatGameClock, isPreGame } from '../domain/gameClock';

export interface GameClockProps {
  gameStartTime: number | null;
  /** Injected in tests; production reads the wall clock. */
  now?: () => number;
}

export function GameClock({ gameStartTime, now = Date.now }: GameClockProps) {
  const [, setTick] = useState(0);
  const preGame = isPreGame(gameStartTime);

  useEffect(() => {
    if (preGame) {
      return;
    }
    const handle = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(handle);
  }, [preGame, gameStartTime]);

  if (preGame) {
    return (
      <span className="live-clock live-clock--pregame" data-testid="game-clock">
        In champion select
      </span>
    );
  }

  return (
    <span className="live-clock" data-testid="game-clock">
      {formatGameClock(elapsedMs(gameStartTime, now()))}
    </span>
  );
}
