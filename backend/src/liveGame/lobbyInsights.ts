/**
 * Lobby Insight Engine (live-game Requirement 3).
 *
 * A pure function of an assembled `LiveGameLobby`: same lobby in, same insights
 * out (Requirement 3.6). It takes no client, no clock and no I/O, so issuing a
 * further Riot call to compute an insight is not expressible (Requirement 3.1) —
 * the same shape as the modules in `backend/src/insight/`.
 *
 *  - 3.2: off-champion — locked-champion mastery below 10,000 AND *some* record
 *    exists for the player. The second clause means a participant whose
 *    enrichment failed entirely (nothing known) is never flagged as being on an
 *    unfamiliar champion.
 *  - 3.3: one-trick — locked-champion mastery at or above 200,000.
 *  - 3.4/3.5: rank spread — the highest and lowest tier among participants with a
 *    ranked entry in the game's queue, or `null` when fewer than two have one.
 */

import type { LeagueEntry } from '../insight/stats';
import {
  RANKED_LEAGUE_QUEUE_TYPE_BY_QUEUE_ID,
  rankedTierOrdinal,
  RANKED_TIERS,
  type LiveGameLobby,
  type LobbyInsights,
  type ParticipantCard,
  type RankedTier,
} from './types';

export const OFF_CHAMPION_MASTERY_THRESHOLD = 10_000;
export const ONE_TRICK_MASTERY_THRESHOLD = 200_000;

/**
 * Requirement 3.2's "at least one ranked entry or mastery record exists": the
 * player is not a total enrichment failure. A non-null (even empty) ranked-entry
 * list is a successful League-V4 result; a non-null mastery is a successful
 * Champion-Mastery result.
 */
function hasAnyRecord(card: ParticipantCard): boolean {
  return (
    (card.rankedEntries !== null && card.rankedEntries.length > 0) ||
    card.championMasteryPoints !== null
  );
}

/** The player's ranked entry for a specific League-V4 `queueType`, if any. */
function rankedEntryForQueue(card: ParticipantCard, queueType: string): LeagueEntry | undefined {
  return card.rankedEntries?.find((entry) => entry.queueType === queueType);
}

export function computeLobbyInsights(lobby: LiveGameLobby): LobbyInsights {
  const offChampion: string[] = [];
  const oneTricks: string[] = [];

  for (const card of lobby.participants) {
    const mastery = card.championMasteryPoints;
    if (mastery === null) {
      continue;
    }
    if (mastery >= ONE_TRICK_MASTERY_THRESHOLD) {
      oneTricks.push(card.puuid);
    } else if (mastery < OFF_CHAMPION_MASTERY_THRESHOLD && hasAnyRecord(card)) {
      offChampion.push(card.puuid);
    }
  }

  return {
    offChampion,
    oneTricks,
    rankSpread: computeRankSpread(lobby),
  };
}

function computeRankSpread(lobby: LiveGameLobby): { highest: RankedTier; lowest: RankedTier } | null {
  const rankedQueueType = RANKED_LEAGUE_QUEUE_TYPE_BY_QUEUE_ID[lobby.queueId];
  if (rankedQueueType === undefined) {
    return null; // not a ranked queue — no spread to compute
  }

  const ordinals: number[] = [];
  for (const card of lobby.participants) {
    const entry = rankedEntryForQueue(card, rankedQueueType);
    if (entry === undefined) {
      continue;
    }
    const ordinal = rankedTierOrdinal(entry.tier);
    if (ordinal !== null) {
      ordinals.push(ordinal);
    }
  }

  if (ordinals.length < 2) {
    return null; // Requirement 3.5
  }

  return {
    highest: RANKED_TIERS[Math.max(...ordinals)],
    lowest: RANKED_TIERS[Math.min(...ordinals)],
  };
}
