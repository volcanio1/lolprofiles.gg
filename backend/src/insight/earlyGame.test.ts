import { describe, expect, it } from 'vitest';
import { goldCsAtOf, lanePhaseDeathCountOf, LANE_PHASE_CUTOFF_MS } from './earlyGame';
import type { TimelineEventDto } from './buildPath';

function kill(victimId: number, timestamp: number): TimelineEventDto {
  return { type: 'CHAMPION_KILL', timestamp, victimId };
}

describe('lanePhaseDeathCountOf (Requirement 15)', () => {
  it('counts only kills before the cutoff where the participant is the victim', () => {
    const events: TimelineEventDto[] = [
      kill(4, 60_000),
      kill(4, LANE_PHASE_CUTOFF_MS - 1),
      kill(4, LANE_PHASE_CUTOFF_MS), // not strictly before -> excluded
      kill(5, 60_000), // different victim
    ];
    expect(lanePhaseDeathCountOf(events, 4)).toBe(2);
  });

  it('ignores non-CHAMPION_KILL events and malformed fields', () => {
    const events: TimelineEventDto[] = [
      { type: 'ITEM_PURCHASED', timestamp: 1_000, participantId: 4, itemId: 1001 },
      { type: 'CHAMPION_KILL', timestamp: undefined as unknown as number, victimId: 4 },
    ];
    expect(lanePhaseDeathCountOf(events, 4)).toBe(0);
  });

  it('is 0 for an empty event list', () => {
    expect(lanePhaseDeathCountOf([], 1)).toBe(0);
  });
});

describe('goldCsAtOf (Requirement 16)', () => {
  it('reads gold and CS from the frame nearest the target', () => {
    const frames = [
      { timestamp: 480_000, participantFrames: { '4': { totalGold: 2_000, minionsKilled: 40, jungleMinionsKilled: 0 } } },
      { timestamp: 600_000, participantFrames: { '4': { totalGold: 3_100, minionsKilled: 60, jungleMinionsKilled: 5 } } },
      { timestamp: 720_000, participantFrames: { '4': { totalGold: 4_000, minionsKilled: 80, jungleMinionsKilled: 5 } } },
    ];
    expect(goldCsAtOf(frames, 4)).toEqual({ gold: 3_100, cs: 65 });
  });

  it('picks the nearest frame even when it is slightly past the target', () => {
    const frames = [
      { timestamp: 540_000, participantFrames: { '4': { totalGold: 2_500, minionsKilled: 50, jungleMinionsKilled: 0 } } },
      { timestamp: 630_000, participantFrames: { '4': { totalGold: 3_300, minionsKilled: 65, jungleMinionsKilled: 0 } } },
    ];
    // 630_000 is 30s from the 600_000 target; 540_000 is 60s away -> 630_000 wins.
    expect(goldCsAtOf(frames, 4)?.gold).toBe(3_300);
  });

  it('is undefined when no frame reaches the target mark (a match under 10 minutes)', () => {
    const frames = [{ timestamp: 300_000, participantFrames: { '4': { totalGold: 1_500, minionsKilled: 20 } } }];
    expect(goldCsAtOf(frames, 4)).toBeUndefined();
  });

  it('is undefined when the nearest frame carries no data for this participant', () => {
    const frames = [{ timestamp: 600_000, participantFrames: { '5': { totalGold: 1_000 } } }];
    expect(goldCsAtOf(frames, 4)).toBeUndefined();
  });

  it('is undefined for an empty frame list', () => {
    expect(goldCsAtOf([], 4)).toBeUndefined();
  });
});
