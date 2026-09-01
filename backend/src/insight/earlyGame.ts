/**
 * Insight Engine — early-game derivations (`player-insights` Phase 2,
 * Requirements 15-16).
 *
 * PURE MODULE, same constraints as `buildPath.ts`: no network, no cache, no
 * clock read, no `process.env`, no logging. Every value comes from the
 * timeline events/frames the caller supplies.
 *
 * Two independent derivations, matching the two Phase 2 feedback categories:
 *  - `lanePhaseDeathCountOf`: `CHAMPION_KILL` events where the given
 *    participant is the victim, before `LANE_PHASE_CUTOFF_MS`.
 *  - `goldCsAtOf`: the given participant's gold/CS from the timeline frame
 *    nearest `EARLY_GAME_SNAPSHOT_MS`, or `undefined` when no frame at or
 *    after that mark exists (the game ended before then — Requirement 16.4).
 *
 * Both take a bare `participantId` (Riot's 1-10 timeline slot number, not a
 * puuid) — resolving a puuid to a participant id, and locating the lane
 * opponent's puuid in the first place, is the orchestrator's job
 * (`orchestrator/earlyGame.ts`), not this module's; this module never sees a
 * puuid at all.
 */

import type { TimelineEventDto } from './buildPath';
import type { ParticipantFrameDto } from '../riotApiClient';

/** Requirement 15.2's default lane-phase cutoff. */
export const LANE_PHASE_CUTOFF_MS = 15 * 60 * 1000;

/** Requirement 16.2's target mark. */
export const EARLY_GAME_SNAPSHOT_MS = 10 * 60 * 1000;

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Requirement 15.2: count of `CHAMPION_KILL` events naming `participantId` as
 * the victim, strictly before `LANE_PHASE_CUTOFF_MS`. Total over any event
 * list — a malformed or missing `timestamp`/`victimId` is simply not counted,
 * the same defensiveness `buildPath.ts`'s reducer already applies (decision 3
 * there).
 */
export function lanePhaseDeathCountOf(events: readonly TimelineEventDto[], participantId: number): number {
  let count = 0;
  for (const event of events) {
    if (event.type !== 'CHAMPION_KILL') {
      continue;
    }
    // `event.type: string` in the catch-all union member is a supertype of
    // the literal `'CHAMPION_KILL'`, so TS cannot narrow away that member from
    // the `type !==` check above — the same cast `extractSkillOrder` already
    // uses for `SKILL_LEVEL_UP` fields, for the same reason.
    const { timestamp, victimId } = event as { timestamp?: unknown; victimId?: unknown };
    if (
      typeof timestamp === 'number' &&
      timestamp < LANE_PHASE_CUTOFF_MS &&
      typeof victimId === 'number' &&
      victimId === participantId
    ) {
      count += 1;
    }
  }
  return count;
}

export interface GoldCsSnapshot {
  gold: number;
  cs: number;
}

interface TimelineFrame {
  timestamp: number;
  participantFrames?: Record<string, ParticipantFrameDto>;
}

/**
 * Requirement 16.2/16.4: the participant's gold and CS (minions + jungle
 * minions) from the frame whose `timestamp` is closest to
 * `EARLY_GAME_SNAPSHOT_MS`, by absolute difference. `undefined` when no frame
 * at or after the target exists (16.4 — the match ended before 10 minutes),
 * or when the nearest frame carries no data for this participant.
 */
export function goldCsAtOf(
  frames: readonly TimelineFrame[],
  participantId: number,
  targetMs: number = EARLY_GAME_SNAPSHOT_MS,
): GoldCsSnapshot | undefined {
  if (!frames.some((frame) => frame.timestamp >= targetMs)) {
    return undefined; // Requirement 16.4
  }

  let nearest: TimelineFrame | undefined;
  let nearestDiff = Number.POSITIVE_INFINITY;
  for (const frame of frames) {
    const diff = Math.abs(frame.timestamp - targetMs);
    if (diff < nearestDiff) {
      nearestDiff = diff;
      nearest = frame;
    }
  }

  const participantFrame = nearest?.participantFrames?.[String(participantId)];
  if (participantFrame === undefined) {
    return undefined;
  }
  return {
    gold: finiteOrZero(participantFrame.totalGold),
    cs: finiteOrZero(participantFrame.minionsKilled) + finiteOrZero(participantFrame.jungleMinionsKilled),
  };
}
