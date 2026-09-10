import { describe, it, expect } from 'vitest';
import type { MatchDto, MatchParticipantDto, MatchTimelineDto } from '../../riotApiClient';
import type { TimelineEventDto } from '../../insight/buildPath';
import { extractObservations, patchOf } from './extractor';

// Real legendary + boot ids from the pinned completed-item set.
const IE = 3031;
const KRAKEN = 6672;
const BOOTS = 3172;
const LONGSWORD = 1036; // component — must not appear in itemPath
const DORAN = 1055; // starter — a starting item, not a core item
const POTION = 2003; // Health Potion — a real starting-item choice, kept

function participant(overrides: Partial<MatchParticipantDto> & { puuid: string }): MatchParticipantDto {
  return {
    championName: 'Jinx',
    teamPosition: 'BOTTOM',
    win: true,
    kills: 0,
    deaths: 0,
    assists: 0,
    visionScore: 0,
    summoner1Id: 4,
    summoner2Id: 7,
    perks: {
      statPerks: { offense: 5008, flex: 5008, defense: 5001 },
      styles: [
        { description: 'primaryStyle', style: 8000, selections: [{ perk: 8005 }, { perk: 9111 }] },
        { description: 'subStyle', style: 8100, selections: [{ perk: 8135 }] },
      ],
    },
    ...overrides,
  } as MatchParticipantDto;
}

function purchase(participantId: number, itemId: number, timestamp: number): TimelineEventDto {
  return { type: 'ITEM_PURCHASED', participantId, itemId, timestamp };
}
function skill(participantId: number, skillSlot: number, timestamp: number): TimelineEventDto {
  return { type: 'SKILL_LEVEL_UP', participantId, skillSlot, timestamp };
}

function matchAndTimeline(opts: {
  queueId?: number;
  gameVersion?: string;
} = {}): { match: MatchDto; timeline: MatchTimelineDto } {
  // two humans + one bot; timeline participant order is SHUFFLED vs match order
  const humanA = participant({ puuid: 'A', championName: 'Jinx', teamPosition: 'BOTTOM', win: true });
  const humanB = participant({ puuid: 'B', championName: 'Lux', teamPosition: 'UTILITY', win: false, summoner1Id: 4, summoner2Id: 3 });
  const bot = participant({ puuid: '', championName: 'Ashe', win: true });

  const match: MatchDto = {
    metadata: { matchId: 'EUW1_1', participants: ['A', 'B', ''] },
    info: {
      queueId: opts.queueId ?? 420,
      gameVersion: opts.gameVersion ?? '16.17.412.9999',
      gameStartTimestamp: 0,
      gameDuration: 1800,
      participants: [humanA, humanB, bot],
    },
  };

  // A is slot 7, B is slot 2 in the timeline — NOT index+1.
  const timeline: MatchTimelineDto = {
    metadata: { matchId: 'EUW1_1', participants: ['A', 'B', ''] },
    info: {
      participants: [
        { participantId: 2, puuid: 'B' },
        { participantId: 7, puuid: 'A' },
        { participantId: 9, puuid: '' },
      ],
      frames: [
        {
          timestamp: 0,
          events: [
            // A (slot 7): Doran + potion at base, then IE, longsword (component), Kraken, boots
            purchase(7, DORAN, 10_000),
            purchase(7, POTION, 12_000),
            purchase(7, IE, 600_000),
            purchase(7, LONGSWORD, 300_000),
            purchase(7, KRAKEN, 900_000),
            purchase(7, BOOTS, 1_200_000),
            skill(7, 1, 60_000),
            skill(7, 1, 120_000),
            skill(7, 1, 180_000),
            skill(7, 1, 240_000),
            skill(7, 1, 300_000), // Q maxed
            skill(7, 2, 360_000),
            // B (slot 2): a couple of buys
            purchase(2, 3853, 15_000), // support starter (not in completed set)
            purchase(2, 6617, 700_000), // completed
          ],
        },
      ],
    },
  };
  return { match, timeline };
}

describe('extractObservations', () => {
  it('returns one Observation per human, joined by puuid (not positional), none for the bot', () => {
    const { match, timeline } = matchAndTimeline();
    const obs = extractObservations(match, timeline);

    expect(obs.map((o) => o.championKey)).toEqual(['Jinx', 'Lux']);

    const jinx = obs[0];
    expect(jinx.role).toBe('BOTTOM');
    expect(jinx.win).toBe(true);
    expect(jinx.patch).toBe('16.17');
    // completed items only, purchase order, capped at Core_Item_Count — component (LONGSWORD) dropped
    expect(jinx.itemPath).toEqual([IE, KRAKEN, BOOTS]);
    // starting items: Doran + Health Potion, in purchase order (trinket would be excluded)
    expect(jinx.startingItems).toEqual([DORAN, POTION]);
    expect(jinx.skillOrder).toEqual({
      maxOrder: ['Q'],
      perLevel: [1, 1, 1, 1, 1, 2],
    });
    expect(jinx.spellPair).toEqual([4, 7]);
    expect(jinx.runePage).not.toBeNull();
  });

  it('keeps potions as starting items but still drops trinkets and the control ward', () => {
    const p = participant({ puuid: 'S' });
    const match: MatchDto = {
      metadata: { matchId: 'EUW1_S', participants: ['S'] },
      info: { queueId: 420, gameVersion: '16.17.1.1', gameStartTimestamp: 0, gameDuration: 100, participants: [p] },
    };
    const timeline: MatchTimelineDto = {
      metadata: { matchId: 'EUW1_S', participants: ['S'] },
      info: {
        participants: [{ participantId: 1, puuid: 'S' }],
        frames: [
          {
            timestamp: 0,
            events: [
              purchase(1, 3850, 5_000), // Spellthief's — support starter
              purchase(1, 2003, 6_000), // Health Potion — kept
              purchase(1, 2003, 7_000), // second Health Potion — kept
              purchase(1, 3340, 8_000), // Warding Trinket — dropped
              purchase(1, 2055, 9_000), // Control Ward — dropped
            ],
          },
        ],
      },
    };
    const [obs] = extractObservations(match, timeline);
    expect(obs.startingItems).toEqual([3850, 2003, 2003]);
  });

  it('returns [] for a non-420 queue', () => {
    const { match, timeline } = matchAndTimeline({ queueId: 450 });
    expect(extractObservations(match, timeline)).toEqual([]);
  });

  it('returns [] when gameVersion is missing or unparseable', () => {
    const a = matchAndTimeline({ gameVersion: '' });
    expect(extractObservations(a.match, a.timeline)).toEqual([]);
    const b = matchAndTimeline({ gameVersion: 'PBE' });
    expect(extractObservations(b.match, b.timeline)).toEqual([]);
  });

  it('null skillOrder / spellPair / runePage when the data is absent', () => {
    const p = participant({ puuid: 'X', summoner1Id: 0, summoner2Id: 0, perks: undefined });
    const match: MatchDto = {
      metadata: { matchId: 'EUW1_9', participants: ['X'] },
      info: { queueId: 420, gameVersion: '16.17.1.1', gameStartTimestamp: 0, gameDuration: 100, participants: [p] },
    };
    const timeline: MatchTimelineDto = {
      metadata: { matchId: 'EUW1_9', participants: ['X'] },
      info: { participants: [{ participantId: 1, puuid: 'X' }], frames: [{ timestamp: 0, events: [] }] },
    };
    const [obs] = extractObservations(match, timeline);
    expect(obs.skillOrder).toBeNull();
    expect(obs.spellPair).toBeNull();
    expect(obs.runePage).toBeNull();
    expect(obs.itemPath).toEqual([]);
    expect(obs.startingItems).toBeNull();
  });
});

describe('patchOf', () => {
  it('takes major.minor', () => {
    expect(patchOf('16.17.412.9999')).toBe('16.17');
    expect(patchOf('9.4.1')).toBe('9.4');
  });
  it('null on junk', () => {
    expect(patchOf('')).toBeNull();
    expect(patchOf(undefined)).toBeNull();
    expect(patchOf('latest')).toBeNull();
  });
});
