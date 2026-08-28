import { describe, expect, it } from 'vitest';
import type { LeagueEntry } from '../insight/stats';
import {
  computeLobbyInsights,
  OFF_CHAMPION_MASTERY_THRESHOLD,
  ONE_TRICK_MASTERY_THRESHOLD,
} from './lobbyInsights';
import type { LiveGameLobby, ParticipantCard } from './types';

function soloEntry(tier: string): LeagueEntry {
  return { queueType: 'RANKED_SOLO_5x5', tier, division: 'I', leaguePoints: 50, wins: 10, losses: 10 };
}

function card(overrides: Partial<ParticipantCard>): ParticipantCard {
  return {
    puuid: 'p',
    teamId: 100,
    championId: 1,
    spell1Id: 4,
    spell2Id: 7,
    perkIds: [],
    isBot: false,
    riotId: null,
    rankedEntries: null,
    championMasteryPoints: null,
    championMasteryLevel: null,
    ...overrides,
  };
}

function lobby(participants: ParticipantCard[], queueId = 420): LiveGameLobby {
  return {
    gameId: 1,
    platformId: 'NA1',
    matchId: 'NA1_1',
    queueId,
    mapId: 11,
    gameStartTime: 1_000,
    bannedChampionIds: [],
    participants,
    insights: { offChampion: [], oneTricks: [], rankSpread: null },
  };
}

describe('computeLobbyInsights — off-champion (Requirement 3.2)', () => {
  it('flags a player below the threshold who has some record', () => {
    const result = computeLobbyInsights(
      lobby([card({ puuid: 'low', championMasteryPoints: OFF_CHAMPION_MASTERY_THRESHOLD - 1, rankedEntries: [soloEntry('GOLD')] })]),
    );
    expect(result.offChampion).toEqual(['low']);
  });

  it('does not flag a player exactly at the threshold', () => {
    const result = computeLobbyInsights(
      lobby([card({ puuid: 'at', championMasteryPoints: OFF_CHAMPION_MASTERY_THRESHOLD, rankedEntries: [] })]),
    );
    expect(result.offChampion).toEqual([]);
  });

  it('does not flag a player whose only signal is a failed mastery call', () => {
    const result = computeLobbyInsights(lobby([card({ puuid: 'unknown', championMasteryPoints: null, rankedEntries: null })]));
    expect(result.offChampion).toEqual([]);
  });

  it('flags a low-mastery player whose ranked call succeeded but returned nothing only when mastery is known', () => {
    // rankedEntries: [] is a record; mastery below threshold -> flagged.
    const flagged = computeLobbyInsights(
      lobby([card({ puuid: 'x', championMasteryPoints: 500, rankedEntries: [] })]),
    );
    expect(flagged.offChampion).toEqual(['x']);
  });
});

describe('computeLobbyInsights — one-trick (Requirement 3.3)', () => {
  it('flags a player at or above the threshold', () => {
    const result = computeLobbyInsights(
      lobby([
        card({ puuid: 'ot', championMasteryPoints: ONE_TRICK_MASTERY_THRESHOLD }),
        card({ puuid: 'below', championMasteryPoints: ONE_TRICK_MASTERY_THRESHOLD - 1, rankedEntries: [soloEntry('GOLD')] }),
      ]),
    );
    expect(result.oneTricks).toEqual(['ot']);
    expect(result.offChampion).toEqual([]);
  });
});

describe('computeLobbyInsights — rank spread (Requirements 3.4/3.5)', () => {
  it('is the highest and lowest tier among participants ranked in the game queue', () => {
    const result = computeLobbyInsights(
      lobby([
        card({ puuid: 'a', rankedEntries: [soloEntry('SILVER')] }),
        card({ puuid: 'b', rankedEntries: [soloEntry('DIAMOND')] }),
        card({ puuid: 'c', rankedEntries: [soloEntry('GOLD')] }),
      ]),
    );
    expect(result.rankSpread).toEqual({ highest: 'DIAMOND', lowest: 'SILVER' });
  });

  it('is null when fewer than two participants are ranked in the game queue', () => {
    const result = computeLobbyInsights(lobby([card({ puuid: 'a', rankedEntries: [soloEntry('SILVER')] })]));
    expect(result.rankSpread).toBeNull();
  });

  it('is null for a non-ranked queue even when participants have ranked entries', () => {
    const result = computeLobbyInsights(
      lobby(
        [
          card({ puuid: 'a', rankedEntries: [soloEntry('SILVER')] }),
          card({ puuid: 'b', rankedEntries: [soloEntry('DIAMOND')] }),
        ],
        430,
      ),
    );
    expect(result.rankSpread).toBeNull();
  });

  it('ignores flex entries when the game is solo queue', () => {
    const flex: LeagueEntry = { queueType: 'RANKED_FLEX_SR', tier: 'CHALLENGER', division: 'I', leaguePoints: 0, wins: 1, losses: 1 };
    const result = computeLobbyInsights(
      lobby([
        card({ puuid: 'a', rankedEntries: [soloEntry('SILVER'), flex] }),
        card({ puuid: 'b', rankedEntries: [flex] }),
      ]),
    );
    expect(result.rankSpread).toBeNull();
  });
});

describe('computeLobbyInsights — purity (Requirement 3.6)', () => {
  it('returns an equal result on repeated invocation', () => {
    const input = lobby([
      card({ puuid: 'a', championMasteryPoints: 5_000, rankedEntries: [soloEntry('GOLD')] }),
      card({ puuid: 'b', championMasteryPoints: 300_000, rankedEntries: [soloEntry('PLATINUM')] }),
    ]);
    expect(computeLobbyInsights(input)).toEqual(computeLobbyInsights(input));
  });
});
