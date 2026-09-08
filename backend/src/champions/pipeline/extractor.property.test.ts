import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { MatchDto, MatchParticipantDto, MatchTimelineDto } from '../../riotApiClient';
import type { TimelineEventDto } from '../../insight/buildPath';
import { COMPLETED_ITEM_IDS } from '../../insight/completedItems';
import { CORE_ITEM_COUNT } from '../buildStatsConstants';
import { extractObservations } from './extractor';

const COMPLETED = [...COMPLETED_ITEM_IDS];
const anyItem = fc.oneof(
  fc.constantFrom(...COMPLETED), // a completed item
  fc.constantFrom(1036, 1052, 1028, 1055, 2003), // components / starters / consumable
);

/** A subsequence check: is `sub` the elements of `full` in order (gaps allowed)? */
function isOrderedSubsequence(sub: readonly number[], full: readonly number[]): boolean {
  let i = 0;
  for (const value of full) {
    if (i < sub.length && sub[i] === value) i += 1;
  }
  return i === sub.length;
}

function baseParticipant(puuid: string): MatchParticipantDto {
  return {
    puuid,
    championName: 'Jinx',
    teamPosition: 'BOTTOM',
    win: true,
    kills: 0,
    deaths: 0,
    assists: 0,
    visionScore: 0,
  } as MatchParticipantDto;
}

describe('extractObservations — properties', () => {
  it('itemPath is always an ordered subsequence of the real completed-item purchases, ≤ CORE_ITEM_COUNT', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(anyItem, fc.integer({ min: 0, max: 2_000_000 })), { maxLength: 30 }),
        (buys) => {
          const slot = 4;
          const events: TimelineEventDto[] = buys.map(([itemId, timestamp]) => ({
            type: 'ITEM_PURCHASED',
            participantId: slot,
            itemId,
            timestamp,
          }));
          const match: MatchDto = {
            metadata: { matchId: 'M', participants: ['P'] },
            info: {
              queueId: 420,
              gameVersion: '16.17.1.1',
              gameStartTimestamp: 0,
              gameDuration: 1,
              participants: [baseParticipant('P')],
            },
          };
          const timeline: MatchTimelineDto = {
            metadata: { matchId: 'M', participants: ['P'] },
            info: {
              participants: [{ participantId: slot, puuid: 'P' }],
              frames: [{ timestamp: 0, events }],
            },
          };

          const [obs] = extractObservations(match, timeline);
          expect(obs).toBeDefined();
          expect(obs.itemPath.length).toBeLessThanOrEqual(CORE_ITEM_COUNT);
          expect(obs.itemPath.every((id) => COMPLETED_ITEM_IDS.has(id))).toBe(true);

          // replayShopEvents may drop undone/immediately-resold buys, so the path is a
          // subsequence of the completed-item buys in purchase order (timestamp then order).
          const completedBuysInOrder = [...buys]
            .map(([itemId, timestamp], index) => ({ itemId, timestamp, index }))
            .sort((a, b) => a.timestamp - b.timestamp || a.index - b.index)
            .map((e) => e.itemId)
            .filter((id) => COMPLETED_ITEM_IDS.has(id));
          expect(isOrderedSubsequence(obs.itemPath, completedBuysInOrder)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a puuid:"" slot never yields an Observation', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('A', 'B', ''), { minLength: 1, maxLength: 10 }), (puuids) => {
        const match: MatchDto = {
          metadata: { matchId: 'M', participants: puuids },
          info: {
            queueId: 420,
            gameVersion: '16.17.1.1',
            gameStartTimestamp: 0,
            gameDuration: 1,
            participants: puuids.map(baseParticipant),
          },
        };
        const timeline: MatchTimelineDto = {
          metadata: { matchId: 'M', participants: puuids },
          info: {
            participants: puuids.map((puuid, i) => ({ participantId: i + 1, puuid })),
            frames: [{ timestamp: 0, events: [] }],
          },
        };
        const obs = extractObservations(match, timeline);
        expect(obs.length).toBeLessThanOrEqual(puuids.filter((p) => p !== '').length);
        // every emitted observation has a real champion (came from a non-empty puuid slot)
        expect(obs.every((o) => o.championKey.length > 0)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
