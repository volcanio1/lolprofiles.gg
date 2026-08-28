import { describe, expect, it } from 'vitest';
import type { LiveParticipantCard, LiveRankedEntry } from '../api/types';
import {
  formatMasteryPoints,
  formatRank,
  formatRankSpread,
  queueLabel,
  rankedEntryForGame,
  titleCaseTier,
} from './liveGame';

const solo = (over: Partial<LiveRankedEntry> = {}): LiveRankedEntry => ({
  queueType: 'RANKED_SOLO_5x5',
  tier: 'GOLD',
  division: 'II',
  leaguePoints: 40,
  wins: 10,
  losses: 10,
  ...over,
});

const card = (over: Partial<LiveParticipantCard> = {}): LiveParticipantCard => ({
  puuid: 'p',
  teamId: 100,
  championId: 1,
  spell1Id: 4,
  spell2Id: 7,
  perkIds: [],
  isBot: false,
  riotId: null,
  rankedEntries: [],
  championMasteryPoints: null,
  championMasteryLevel: null,
  ...over,
});

describe('queueLabel', () => {
  it('names known queues and falls back for unknown ones', () => {
    expect(queueLabel(420)).toBe('Ranked Solo/Duo');
    expect(queueLabel(99999)).toBe('Queue 99999');
  });
});

describe('titleCaseTier / formatRank', () => {
  it('title-cases the tier and includes the division below apex', () => {
    expect(titleCaseTier('DIAMOND')).toBe('Diamond');
    expect(formatRank(solo({ tier: 'GOLD', division: 'II', leaguePoints: 40 }))).toBe('Gold II · 40 LP');
  });

  it('drops the division at Master and above', () => {
    expect(formatRank(solo({ tier: 'CHALLENGER', division: 'I', leaguePoints: 1200 }))).toBe('Challenger · 1200 LP');
  });
});

describe('rankedEntryForGame', () => {
  it('returns the solo entry for a solo-queue game', () => {
    expect(rankedEntryForGame(card({ rankedEntries: [solo()] }), 420)).toEqual(solo());
  });

  it('returns undefined for a non-ranked queue', () => {
    expect(rankedEntryForGame(card({ rankedEntries: [solo()] }), 430)).toBeUndefined();
  });

  it('returns undefined when the League call failed (rankedEntries null)', () => {
    expect(rankedEntryForGame(card({ rankedEntries: null }), 420)).toBeUndefined();
  });
});

describe('formatMasteryPoints', () => {
  it('compacts thousands and leaves small values alone', () => {
    expect(formatMasteryPoints(142_340)).toBe('142K');
    expect(formatMasteryPoints(900)).toBe('900');
  });
});

describe('formatRankSpread', () => {
  it('renders lowest to highest, title-cased', () => {
    expect(formatRankSpread({ highest: 'DIAMOND', lowest: 'SILVER' })).toBe('Silver – Diamond');
  });
});
